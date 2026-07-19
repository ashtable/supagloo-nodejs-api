import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, type PrismaClient } from "@supagloo/database-lib";
import { GlooConnectionService } from "./gloo-connection-service";
import { GlooVerificationError } from "./errors";

// GlooConnectionService branch logic (design-delta §2.5/§8). The headline invariant
// is VERIFY-THEN-STORE: a client-credentials test mint must succeed BEFORE any row
// is written; a failed verify creates/updates nothing. Fake Prisma + fake verifier
// + fixed clock + a REAL 64-hex key drive every branch.

const NOW = new Date("2026-07-18T12:00:00.000Z");
const clock = () => NOW;
const KEY = randomBytes(32).toString("hex");

type Fn = (args: any) => any;
interface FakeOverrides {
  findUnique?: Fn;
  upsert?: Fn;
  deleteMany?: Fn;
}

function makeFakePrisma(overrides: FakeOverrides = {}) {
  const calls = {
    findUnique: [] as any[],
    upsert: [] as any[],
    deleteMany: [] as any[],
  };
  const run = (key: keyof FakeOverrides, args: any, fallback: any) => {
    (calls as any)[key].push(args);
    const fn = overrides[key];
    return Promise.resolve(fn ? fn(args) : fallback);
  };
  const prisma = {
    glooConnection: {
      findUnique: (a: any) => run("findUnique", a, null),
      upsert: (a: any) => run("upsert", a, { userId: "u1", ...a.create }),
      deleteMany: (a: any) => run("deleteMany", a, { count: 1 }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

function service(
  prisma: PrismaClient,
  verifyClientCredentials: (args: {
    clientId: string;
    clientSecret: string;
  }) => Promise<boolean>,
) {
  return new GlooConnectionService({
    prisma,
    verifyClientCredentials,
    encryptionKey: KEY,
    clock,
  });
}

describe("GlooConnectionService.connect — verify-then-store ordering", () => {
  it("does NOT write a row when the client-credentials mint fails (throws 400)", async () => {
    const { prisma, calls } = makeFakePrisma();
    const verifier = async () => false;

    await expect(
      service(prisma, verifier).connect("u1", {
        clientId: "cid",
        clientSecret: "bad",
      }),
    ).rejects.toBeInstanceOf(GlooVerificationError);

    // The verify failure must leave NO trace of a write.
    expect(calls.upsert).toHaveLength(0);
  });

  it("mints successfully THEN encrypts + stores clientId + secret ciphertext + timestamps", async () => {
    const { prisma, calls } = makeFakePrisma();
    let verifiedWith: unknown;
    const verifier = async (args: { clientId: string; clientSecret: string }) => {
      verifiedWith = args;
      return true;
    };

    const conn = await service(prisma, verifier).connect("u1", {
      clientId: "cid",
      clientSecret: "csecret",
    });

    // Verified with the exact credentials.
    expect(verifiedWith).toEqual({ clientId: "cid", clientSecret: "csecret" });

    expect(calls.upsert).toHaveLength(1);
    const upsert = calls.upsert[0];
    expect(upsert.where).toEqual({ userId: "u1" });
    // Exactly the persisted columns — clientId is plaintext, the SECRET is ciphertext.
    expect(new Set(Object.keys(upsert.create))).toEqual(
      new Set([
        "userId",
        "clientId",
        "clientSecretCiphertext",
        "status",
        "connectedAt",
        "lastVerifiedAt",
      ]),
    );
    expect(upsert.create.clientId).toBe("cid");
    expect(upsert.create.status).toBe("connected");
    expect(upsert.create.connectedAt).toEqual(NOW);
    expect(upsert.create.lastVerifiedAt).toEqual(NOW);

    // The secret is stored as ciphertext, never plaintext, and round-trips.
    const ct = upsert.create.clientSecretCiphertext as string;
    expect(ct).not.toBe("csecret");
    expect(ct.includes("csecret")).toBe(false);
    expect(decryptSecret(ct, KEY)).toBe("csecret");

    // No plaintext-secret-bearing key name anywhere in the write.
    const allKeys = [
      ...Object.keys(upsert.create),
      ...Object.keys(upsert.update ?? {}),
    ].join(",");
    expect(allKeys).not.toMatch(/clientSecret(?!Ciphertext)/);

    expect(conn.clientId).toBe("cid");
  });
});

describe("GlooConnectionService.disconnect", () => {
  it("deleteMany by userId (idempotent — a 0-count delete does not throw)", async () => {
    const { prisma, calls } = makeFakePrisma({ deleteMany: () => ({ count: 0 }) });
    await service(prisma, async () => true).disconnect("u1");
    expect(calls.deleteMany).toEqual([{ where: { userId: "u1" } }]);
  });
});
