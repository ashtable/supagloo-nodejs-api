import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPrismaClient, type PrismaClient } from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { SESSION_TTL_MS } from "../../src/auth/tokens";

// Non-UI e2e for auth & SESSION MECHANICS (Task #10; reworked for zero YouVersion
// egress in Task 34-E6 / design-delta §10.4b). Boots the REAL Fastify app
// in-process (real listen + real fetch over loopback) against REAL Postgres (the
// Compose `supagloo` DB). Infra is ensured by tests/e2e/global-setup.ts.
//
// ZERO YouVersion egress (design-delta §10.4b, "real or not at all"): interactive
// YouVersion OAuth cannot be automated, so this suite exercises only session/bearer
// mechanics through the `/v1/test/seed` seam — NEVER the userinfo verifier. The
// verifier is unit-tested with an injected fetch (src/auth/youversion.test.ts), and
// the real `POST /v1/auth/youversion` → live userinfo round-trip is the optional,
// env-gated tests/e2e/auth-live-youversion.e2e.ts. The old stub-URL fallback and the
// two stub-dependent sign-in tests were deleted here. To PROVE zero egress, the
// AuthService below is wired with a verifier that THROWS if ever invoked.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";

describe("e2e: auth & session mechanics (zero YouVersion egress)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: APP_URL });
    const authService = new AuthService({
      prisma,
      // This suite must NEVER reach YouVersion (§10.4b). Session mechanics go
      // through /v1/test/seed, which never calls verifyToken; a throwing verifier
      // turns any accidental sign-in egress into a loud, immediate failure.
      verifyToken: async () => {
        throw new Error(
          "auth.e2e.ts must have ZERO YouVersion egress (design-delta §10.4b): " +
            "session-mechanics tests use the /v1/test/seed seam and must never " +
            "invoke the userinfo verifier. Live sign-in is covered by the " +
            "optional tests/e2e/auth-live-youversion.e2e.ts.",
        );
      },
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

  it("seeded session authorizes /v1/me, completes onboarding, and revokes on signout", async () => {
    // Unique per run so the seeded user/session are fresh even though the DB
    // persists across reruns.
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const sessionToken = `auth-e2e-${stamp}`;
    const youversionUserId = `yv-auth-${stamp}`;

    const seed = await post("/v1/test/seed", {
      users: [
        {
          youversionUserId,
          displayName: "Auth E2E",
          email: `auth-${stamp}@example.test`,
          avatarInitials: "AE",
          sessionToken,
        },
      ],
    });
    expect(seed.status).toBe(200);

    // 1) The seeded session token authorizes GET /v1/me — no OAuth flow.
    const me = await authed("GET", "/v1/me", sessionToken);
    expect(me.status).toBe(200);
    const meBody = await me.json();
    expect(meBody.user.youversionUserId).toBe(youversionUserId);
    expect(meBody.user.onboardingCompletedAt).toBeNull();

    // 2) Onboarding stamps onboardingCompletedAt and persists.
    const onboard = await authed("PATCH", "/v1/me/onboarding", sessionToken);
    expect(onboard.status).toBe(200);
    expect((await onboard.json()).user.onboardingCompletedAt).not.toBeNull();
    const meAfter = await authed("GET", "/v1/me", sessionToken);
    expect((await meAfter.json()).user.onboardingCompletedAt).not.toBeNull();

    // 3) Signout deletes the session; the token no longer authorizes (§9-Q6).
    const signout = await post("/v1/auth/signout", {}, sessionToken);
    expect(signout.status).toBe(200);
    expect((await signout.json()).ok).toBe(true);

    const revoked = await authed("GET", "/v1/me", sessionToken);
    expect(revoked.status).toBe(401);
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
