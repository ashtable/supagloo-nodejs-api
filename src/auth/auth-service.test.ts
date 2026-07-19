import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import { AuthService } from "./auth-service";
import { UnauthorizedError } from "./errors";
import { hashToken } from "./tokens";
import type { YouVersionVerifier } from "./youversion";

// AuthService branch logic (design-delta §2.1/§2.2/§6a/§9-Q6). No real DB — a
// hand-rolled fake Prisma records calls and returns canned rows. The real DB is
// exercised end-to-end in tests/e2e/auth.e2e.ts.

const NOW = new Date("2026-07-18T12:00:00.000Z");
const TTL = 1000;
const clock = () => NOW;

const INFO = {
  youversionUserId: "yv-user-1001",
  displayName: "Ada Lovelace",
  email: "ada@example.test",
  avatarInitials: "AL",
};
const verifyOk: YouVersionVerifier = async () => INFO;
const verifyReject: YouVersionVerifier = async () => null;

type Fn = (args: any) => any;
interface FakeOverrides {
  userFindUnique?: Fn;
  userCreate?: Fn;
  userUpdate?: Fn;
  userUpsert?: Fn;
  sessionFindUnique?: Fn;
  sessionCreate?: Fn;
  sessionUpdate?: Fn;
  sessionDelete?: Fn;
  sessionUpsert?: Fn;
}

function makeFakePrisma(overrides: FakeOverrides = {}) {
  const calls = {
    userFindUnique: [] as any[],
    userCreate: [] as any[],
    userUpdate: [] as any[],
    userUpsert: [] as any[],
    sessionFindUnique: [] as any[],
    sessionCreate: [] as any[],
    sessionUpdate: [] as any[],
    sessionDelete: [] as any[],
    sessionUpsert: [] as any[],
  };
  const run = (key: keyof FakeOverrides, args: any, fallback: any) => {
    (calls as any)[key].push(args);
    const fn = overrides[key];
    return Promise.resolve(fn ? fn(args) : fallback);
  };
  const prisma = {
    user: {
      findUnique: (a: any) => run("userFindUnique", a, null),
      create: (a: any) => run("userCreate", a, { id: "u_created", ...a.data }),
      update: (a: any) => run("userUpdate", a, { id: "u_updated", ...a.data }),
      upsert: (a: any) => run("userUpsert", a, { id: "u_upserted", ...a.create }),
    },
    session: {
      findUnique: (a: any) => run("sessionFindUnique", a, null),
      create: (a: any) => run("sessionCreate", a, { id: "s_created", ...a.data }),
      update: (a: any) => run("sessionUpdate", a, { id: "s_updated", ...a.data }),
      delete: (a: any) => run("sessionDelete", a, { id: "s_deleted" }),
      upsert: (a: any) => run("sessionUpsert", a, { id: "s_upserted", ...a.create }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

function service(prisma: PrismaClient, verify: YouVersionVerifier = verifyOk) {
  return new AuthService({
    prisma,
    verifyToken: verify,
    clock,
    sessionTtlMs: TTL,
  });
}

describe("AuthService.signIn — first-sign-in upsert semantics", () => {
  it("CREATE branch: new user ⇒ firstSignIn true, firstSignInAt set, session minted", async () => {
    const { prisma, calls } = makeFakePrisma({ userFindUnique: () => null });
    const result = await service(prisma).signIn("access-abc");

    expect(result.firstSignIn).toBe(true);
    expect(calls.userCreate).toHaveLength(1);
    expect(calls.userUpdate).toHaveLength(0);
    expect(calls.userCreate[0].data.firstSignInAt).toEqual(NOW);
    expect(calls.userCreate[0].data.youversionUserId).toBe("yv-user-1001");

    // Only the SHA-256 hash of the returned raw token is persisted.
    expect(calls.sessionCreate).toHaveLength(1);
    const sess = calls.sessionCreate[0].data;
    expect(sess.tokenHash).toBe(hashToken(result.token));
    expect(sess.tokenHash).not.toBe(result.token);
    expect(sess.expiresAt).toEqual(new Date(NOW.getTime() + TTL));
    expect(sess.lastUsedAt).toEqual(NOW);
  });

  it("UPDATE branch: existing user ⇒ firstSignIn false, no create, firstSignInAt untouched", async () => {
    const existing = { id: "u1", youversionUserId: "yv-user-1001" };
    const { prisma, calls } = makeFakePrisma({
      userFindUnique: () => existing,
    });
    const result = await service(prisma).signIn("access-abc");

    expect(result.firstSignIn).toBe(false);
    expect(calls.userCreate).toHaveLength(0);
    expect(calls.userUpdate).toHaveLength(1);
    expect(calls.userUpdate[0].data.firstSignInAt).toBeUndefined();
    expect(calls.sessionCreate).toHaveLength(1);
  });

  it("defensive: create losing a race (P2002) falls back to update, firstSignIn false", async () => {
    const { prisma, calls } = makeFakePrisma({
      userFindUnique: () => null,
      userCreate: () => {
        throw { code: "P2002" };
      },
      userUpdate: () => ({ id: "u1" }),
    });
    const result = await service(prisma).signIn("access-abc");

    expect(result.firstSignIn).toBe(false);
    expect(calls.userUpdate).toHaveLength(1);
    expect(calls.sessionCreate).toHaveLength(1);
  });

  it("rejects an invalid YouVersion access token with UnauthorizedError (no writes)", async () => {
    const { prisma, calls } = makeFakePrisma();
    await expect(service(prisma, verifyReject).signIn("bad")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(calls.userFindUnique).toHaveLength(0);
    expect(calls.userCreate).toHaveLength(0);
    expect(calls.sessionCreate).toHaveLength(0);
  });
});

describe("AuthService.authenticate — bearer lookup + sliding expiry", () => {
  it("garbage token ⇒ null, looked up by SHA-256 hash, no bump", async () => {
    const { prisma, calls } = makeFakePrisma({ sessionFindUnique: () => null });
    const result = await service(prisma).authenticate("garbage");

    expect(result).toBeNull();
    expect(calls.sessionFindUnique[0].where.tokenHash).toBe(hashToken("garbage"));
    expect(calls.sessionUpdate).toHaveLength(0);
  });

  it("expired session ⇒ null, no bump", async () => {
    const { prisma, calls } = makeFakePrisma({
      sessionFindUnique: () => ({
        id: "s1",
        expiresAt: new Date(NOW.getTime() - 1),
        user: { id: "u1" },
      }),
    });
    const result = await service(prisma).authenticate("tok");

    expect(result).toBeNull();
    expect(calls.sessionUpdate).toHaveLength(0);
  });

  it("valid session ⇒ user returned and sliding expiry bumps lastUsedAt/expiresAt", async () => {
    const { prisma, calls } = makeFakePrisma({
      sessionFindUnique: () => ({
        id: "s1",
        expiresAt: new Date(NOW.getTime() + 60_000),
        user: { id: "u1", youversionUserId: "yv-user-1001" },
      }),
    });
    const result = await service(prisma).authenticate("tok");

    expect(result?.user.id).toBe("u1");
    expect(calls.sessionUpdate).toHaveLength(1);
    expect(calls.sessionUpdate[0].where.id).toBe("s1");
    expect(calls.sessionUpdate[0].data.lastUsedAt).toEqual(NOW);
    expect(calls.sessionUpdate[0].data.expiresAt).toEqual(
      new Date(NOW.getTime() + TTL),
    );
  });
});

describe("AuthService.signOut — DB-backed revocation (§9-Q6)", () => {
  it("deletes the session row by id", async () => {
    const { prisma, calls } = makeFakePrisma();
    await service(prisma).signOut("s1");
    expect(calls.sessionDelete).toHaveLength(1);
    expect(calls.sessionDelete[0].where.id).toBe("s1");
  });
});

describe("AuthService.completeOnboarding", () => {
  it("stamps onboardingCompletedAt on the user", async () => {
    const { prisma, calls } = makeFakePrisma({
      userUpdate: (a) => ({ id: a.where.id, onboardingCompletedAt: a.data.onboardingCompletedAt }),
    });
    const user = await service(prisma).completeOnboarding("u1");
    expect(calls.userUpdate[0].where.id).toBe("u1");
    expect(calls.userUpdate[0].data.onboardingCompletedAt).toEqual(NOW);
    expect(user.onboardingCompletedAt).toEqual(NOW);
  });
});

describe("AuthService.seed — deterministic users/sessions", () => {
  it("upserts a user + session keyed by the caller's token hash", async () => {
    const { prisma, calls } = makeFakePrisma({
      userUpsert: (a) => ({ id: "u_seed", ...a.create }),
    });
    const result = await service(prisma).seed({
      users: [
        {
          youversionUserId: "yv-seed-1",
          displayName: "Seed One",
          email: "seed1@example.test",
          avatarInitials: "SO",
          sessionToken: "seed-token-1",
        },
      ],
    });

    expect(calls.userUpsert).toHaveLength(1);
    expect(calls.sessionUpsert).toHaveLength(1);
    expect(calls.sessionUpsert[0].create.tokenHash).toBe(hashToken("seed-token-1"));
    expect(result.users).toHaveLength(1);
    expect(result.users[0].token).toBe("seed-token-1");
    expect(result.users[0].user.id).toBe("u_seed");
  });
});
