import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPrismaClient, type PrismaClient } from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import {
  resolveYouVersionLiveGate,
  YOUVERSION_E2E_TOKEN_VAR,
} from "../../src/testing/youversion-live-e2e";

// OPTIONAL, env-gated live YouVersion sign-in e2e (design-delta §10.4b). This is
// the ONE deliberately-optional real spec: it drives the REAL POST
// /v1/auth/youversion → live YouVersion userinfo → real User upsert → real opaque
// session, against the REAL host (YOUVERSION_BASE_URL, default
// https://api.youversion.com — NEVER a stub), using a dedicated test account's
// YOUVERSION_E2E_ACCESS_TOKEN. Interactive YouVersion OAuth cannot be automated, so
// the token is obtained out-of-band and supplied via env. When it is unset the spec
// SKIPS LOUDLY (a visible console.warn), never silently — every OTHER e2e provider
// secret fails fast instead (§10.8). Boots the app in-process like auth.e2e.ts but
// with a REAL verifier (real egress is the whole point here).
//
// ACCEPTED RISK / KNOWN CAVEAT (design-delta §10.4b + Task 34-E6 investigation):
// the SHIPPED verifier (src/auth/youversion.ts) implements an INVENTED
// `GET {base}/auth/v1/userinfo` contract. The real "Sign in with YouVersion" flow
// is JWT-claims-based (POST /auth/token → access_token/id_token with claims
// yvp_id/sub, email, name, profile_picture; no userinfo GET endpoint). So this spec
// drives whatever verifier ships today; setting a real token now will likely fail
// at the (nonexistent) userinfo endpoint until a follow-up rewrites the verifier to
// decode+verify JWT claims and store a refresh token (access tokens expire ~1h).
// That is why the always-on gating suite keeps the userinfo contract unproven and
// this spec is optional. It is honest, not a green lie: it skips loudly by default
// and asserts only structural, value-agnostic facts about the live account.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
// REAL host — the app-boot base-URL var, defaulting to production YouVersion
// (src/config/env.ts). No stub-port fallback (§10.2: real or not at all).
const YOUVERSION_BASE =
  process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";

const gate = resolveYouVersionLiveGate();
if (!gate.enabled) {
  // LOUD skip — visible in the test output, naming the var. Never a silent no-op.
  // eslint-disable-next-line no-console
  console.warn(gate.skipWarning);
}

describe.skipIf(!gate.enabled)(
  "e2e: LIVE YouVersion sign-in (optional, env-gated)",
  () => {
    let app: FastifyInstance;
    let prisma: PrismaClient;
    let baseUrl: string;

    beforeAll(async () => {
      prisma = createPrismaClient({ connectionString: APP_URL });
      const authService = new AuthService({
        prisma,
        // REAL verifier against the REAL host — this spec's entire purpose is to
        // exercise live YouVersion egress with a real access token.
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

    it(`mints a session from LIVE YouVersion userinfo and authorizes /v1/me (${YOUVERSION_E2E_TOKEN_VAR})`, async () => {
      const accessToken = gate.token!;

      // Real sign-in: API verifies the token against LIVE YouVersion, upserts the
      // User, and mints an opaque session.
      const signIn = await fetch(`${baseUrl}/v1/auth/youversion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });
      expect(signIn.status).toBe(200);
      const body = await signIn.json();

      // Opaque session token minted from the real round-trip.
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(20);
      expect(typeof body.firstSignIn).toBe("boolean");

      // Structural assertions on the LIVE account's userinfo — values vary run to
      // run and per account, so assert shape/non-emptiness, never fixed values.
      expect(typeof body.user.youversionUserId).toBe("string");
      expect(body.user.youversionUserId.length).toBeGreaterThan(0);
      expect(typeof body.user.email).toBe("string");
      expect(typeof body.user.displayName).toBe("string");
      expect(body.user.displayName.length).toBeGreaterThan(0);
      expect(typeof body.user.avatarInitials).toBe("string");

      // The minted opaque session authorizes GET /v1/me → same identity.
      const me = await fetch(`${baseUrl}/v1/me`, {
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(me.status).toBe(200);
      const meBody = await me.json();
      expect(meBody.user.youversionUserId).toBe(body.user.youversionUserId);
    });
  },
);
