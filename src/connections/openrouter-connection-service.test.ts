import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, type PrismaClient } from "@supagloo/database-lib";
import { OpenRouterConnectionService } from "./openrouter-connection-service";
import { OpenRouterNotConnectedError } from "./errors";

// OpenRouterConnectionService branch logic (design-delta §2.5/§8). No real DB or
// network — a hand-rolled fake Prisma + fake credits client + fixed clock + a REAL
// 64-hex key (encryptSecret/decryptSecret are pure) drive every branch. The real
// DB + real stub are exercised in tests/e2e/connections.e2e.ts.

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
    openRouterConnection: {
      findUnique: (a: any) => run("findUnique", a, null),
      upsert: (a: any) => run("upsert", a, { userId: "u1", ...a.create }),
      deleteMany: (a: any) => run("deleteMany", a, { count: 1 }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

function service(
  prisma: PrismaClient,
  getCredits: (apiKey: string) => Promise<{ totalCredits: number; totalUsage: number }>,
) {
  return new OpenRouterConnectionService({
    prisma,
    getCredits,
    encryptionKey: KEY,
    clock,
  });
}

const noopCredits = async () => ({ totalCredits: 0, totalUsage: 0 });

describe("OpenRouterConnectionService.connect", () => {
  it("derives keyLast4 from the RAW key and stores ciphertext, never plaintext", async () => {
    const { prisma, calls } = makeFakePrisma();
    const rawKey = "sk-or-v1-0123456789abcdefwxyz";

    const conn = await service(prisma, noopCredits).connect("u1", rawKey);

    expect(calls.upsert).toHaveLength(1);
    const upsert = calls.upsert[0];
    expect(upsert.where).toEqual({ userId: "u1" });
    // Exactly the 4 persisted columns (+ userId) — no plaintext key column.
    expect(new Set(Object.keys(upsert.create))).toEqual(
      new Set(["userId", "apiKeyCiphertext", "keyLast4", "status", "connectedAt"]),
    );
    // Masked-display derivation: last 4 chars of the raw key.
    expect(upsert.create.keyLast4).toBe("wxyz");
    expect(upsert.create.status).toBe("connected");
    expect(upsert.create.connectedAt).toEqual(NOW);

    // Ciphertext ≠ plaintext, and the plaintext (and its tail) do not survive in it.
    const ct = upsert.create.apiKeyCiphertext as string;
    expect(ct).not.toBe(rawKey);
    expect(ct.includes(rawKey)).toBe(false);
    // But it round-trips with the same key.
    expect(decryptSecret(ct, KEY)).toBe(rawKey);

    // No plaintext-key-bearing key name in the write payload.
    const allKeys = [
      ...Object.keys(upsert.create),
      ...Object.keys(upsert.update ?? {}),
    ].join(",");
    expect(allKeys).not.toMatch(/apiKey(?!Ciphertext)|plaintext/i);

    expect(conn.keyLast4).toBe("wxyz");
  });
});

describe("OpenRouterConnectionService.getCredits", () => {
  it("throws OpenRouterNotConnectedError (409) when there is no connection", async () => {
    const { prisma } = makeFakePrisma({ findUnique: () => null });
    let clientCalled = false;
    await expect(
      service(prisma, async () => {
        clientCalled = true;
        return { totalCredits: 0, totalUsage: 0 };
      }).getCredits("u1"),
    ).rejects.toBeInstanceOf(OpenRouterNotConnectedError);
    expect(clientCalled).toBe(false);
  });

  it("decrypts the stored key, proxies, and reshapes with remaining", async () => {
    const rawKey = "sk-or-v1-super-secret-key";
    // Simulate a persisted row: encrypt the same way connect() would.
    const stored = await service(makeFakePrisma().prisma, noopCredits).connect(
      "u1",
      rawKey,
    );
    const { prisma } = makeFakePrisma({
      findUnique: () => stored,
    });

    let sawKey: string | undefined;
    const credits = await service(prisma, async (apiKey) => {
      sawKey = apiKey;
      return { totalCredits: 100, totalUsage: 12.5 };
    }).getCredits("u1");

    // The DECRYPTED key (not the ciphertext) is what the proxy forwards.
    expect(sawKey).toBe(rawKey);
    expect(credits).toEqual({
      totalCredits: 100,
      totalUsage: 12.5,
      remaining: 87.5,
    });
  });
});

describe("OpenRouterConnectionService.disconnect", () => {
  it("deleteMany by userId (idempotent — a 0-count delete does not throw)", async () => {
    const { prisma, calls } = makeFakePrisma({ deleteMany: () => ({ count: 0 }) });
    await service(prisma, noopCredits).disconnect("u1");
    expect(calls.deleteMany).toEqual([{ where: { userId: "u1" } }]);
  });
});
