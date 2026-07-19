import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPrismaClient, type PrismaClient } from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";

// Non-UI e2e for auth & sessions (Task #10). Boots the REAL Fastify app in-process
// (real listen + real fetch over loopback), wired to a REAL Postgres (the Compose
// `supagloo` DB) and the REAL containerized YouVersion stub (host port 4804). No
// provider/DB mocking — the stub is a real HTTP server, the DB is real Postgres.
// Infra is ensured by tests/e2e/global-setup.ts (reuse-or-spawn).

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";

describe("e2e: auth & sessions", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: APP_URL });
    const authService = new AuthService({
      prisma,
      verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
      clock: () => new Date(),
      sessionTtlMs: SESSION_TTL_MS,
    });
    app = buildApp({
      auth: {
        authService,
        env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
      },
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  const post = (path: string, body: unknown, bearer?: string) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });

  const authed = (method: string, path: string, bearer: string) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}` },
    });

  it("signs in, authorizes /v1/me, updates on re-signin, onboards, and revokes on signout", async () => {
    // Unique per run so the derived YouVersion user is fresh even though the DB
    // persists across reruns — makes the create-vs-update branch deterministic.
    const accessToken = `yv-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // 1) Sign in — CREATE branch.
    const signIn = await post("/v1/auth/youversion", { accessToken });
    expect(signIn.status).toBe(200);
    const signInBody = await signIn.json();
    expect(signInBody.firstSignIn).toBe(true);
    expect(typeof signInBody.token).toBe("string");
    expect(signInBody.token.length).toBeGreaterThan(20);
    expect(signInBody.user.youversionUserId).toBe(`yv_${accessToken}`);
    const sessionToken: string = signInBody.token;
    const userId: string = signInBody.user.id;

    // 2) The session token authorizes GET /v1/me.
    const me = await authed("GET", "/v1/me", sessionToken);
    expect(me.status).toBe(200);
    expect((await me.json()).user.youversionUserId).toBe(`yv_${accessToken}`);

    // 3) Sign in again with the SAME access token — UPDATE branch, same user.
    const reSignIn = await post("/v1/auth/youversion", { accessToken });
    expect(reSignIn.status).toBe(200);
    const reSignInBody = await reSignIn.json();
    expect(reSignInBody.firstSignIn).toBe(false);
    expect(reSignInBody.user.id).toBe(userId);

    // 4) Onboarding stamps onboardingCompletedAt and persists.
    const onboard = await authed("PATCH", "/v1/me/onboarding", sessionToken);
    expect(onboard.status).toBe(200);
    expect((await onboard.json()).user.onboardingCompletedAt).not.toBeNull();
    const meAfter = await authed("GET", "/v1/me", sessionToken);
    expect((await meAfter.json()).user.onboardingCompletedAt).not.toBeNull();

    // 5) Signout deletes the session; the token no longer authorizes (§9-Q6).
    const signout = await post("/v1/auth/signout", {}, sessionToken);
    expect(signout.status).toBe(200);
    expect((await signout.json()).ok).toBe(true);

    const revoked = await authed("GET", "/v1/me", sessionToken);
    expect(revoked.status).toBe(401);
  });

  it("rejects an invalid YouVersion access token with 401", async () => {
    const res = await post("/v1/auth/youversion", {
      accessToken: "yv-access-invalid",
    });
    expect(res.status).toBe(401);
  });

  it("seed endpoint mints a session usable directly for bearer auth", async () => {
    const seedToken = `seed-e2e-${Date.now()}`;
    const youversionUserId = `yv-seed-${Date.now()}`;
    const seed = await post("/v1/test/seed", {
      users: [
        {
          youversionUserId,
          displayName: "Seed E2E",
          email: "seed-e2e@example.test",
          avatarInitials: "SE",
          sessionToken: seedToken,
        },
      ],
    });
    expect(seed.status).toBe(200);
    const seedBody = await seed.json();
    expect(seedBody.users[0].token).toBe(seedToken);

    // The seeded session token authorizes /v1/me with no OAuth flow.
    const me = await authed("GET", "/v1/me", seedToken);
    expect(me.status).toBe(200);
    expect((await me.json()).user.youversionUserId).toBe(youversionUserId);
  });
});
