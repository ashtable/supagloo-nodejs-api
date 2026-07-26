import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerTestGithubOauthRoute } from "./test-github-oauth";

/**
 * The flag-gated, TEST-ONLY user-authorization token-exchange route (plan row 66).
 *
 * It exists for exactly one reason: the create-new-repo flow's second hop,
 * `POST {oauthBase}/login/oauth/access_token`, is a SERVER-side call made by the
 * api process, so a browser spec has no seam to intercept it. With the
 * public/internal base split, the containerised api can be pointed at ITSELF
 * (`GITHUB_OAUTH_INTERNAL_BASE_URL=http://api:4000`) for that one hop while the
 * browser keeps redirecting to real github.com.
 *
 * Its protection is EXACTLY `POST /v1/test/seed`'s double gate (§9-Q9) —
 * `NODE_ENV !== 'production'` AND the literal `SUPAGLOO_ENABLE_TEST_SEED === '1'`,
 * enforced by NOT REGISTERING the route, so a failed gate is a true 404 from
 * Fastify's own not-found handler rather than a 401/403 that would leak the
 * route's existence. This mirrors `test-seed.test.ts`'s four-case matrix
 * deliberately: the two routes must never drift apart.
 *
 * Two properties beyond the seed route's:
 *   • it registers OUTSIDE the `/v1` scope, because the client requests a fixed
 *     `/login/oauth/access_token` suffix with no version prefix;
 *   • an absent `GITHUB_E2E_EXCHANGE_TOKEN` FAILS FAST naming the variable. It must
 *     never return a placeholder and never silently disable itself — a spec that
 *     quietly stopped exercising the real exchange is a green lie.
 */

const TOKEN = "github_pat_test_only_placeholder";

async function buildOauthApp(env: {
  NODE_ENV: "development" | "test" | "production";
  SUPAGLOO_ENABLE_TEST_SEED?: string;
  GITHUB_E2E_EXCHANGE_TOKEN?: string;
}): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerTestGithubOauthRoute(app, { env });
  await app.ready();
  return app;
}

const exchangeBody = {
  client_id: "Iv1.testclient",
  client_secret: "testsecret",
  code: "any-code-at-all",
};

describe("POST /login/oauth/access_token — double-gate hard-404 (plan row 66, §9-Q9)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  const post = (url = "/login/oauth/access_token") =>
    app!.inject({ method: "POST", url, payload: exchangeBody });

  it("404s in non-prod when the flag is UNSET (flag off ⇒ 404 even in non-prod)", async () => {
    app = await buildOauthApp({
      NODE_ENV: "development",
      GITHUB_E2E_EXCHANGE_TOKEN: TOKEN,
    });
    const res = await post();
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not Found");
  });

  it("404s in PRODUCTION even when the flag is '1' (prod ⇒ 404 regardless)", async () => {
    app = await buildOauthApp({
      NODE_ENV: "production",
      SUPAGLOO_ENABLE_TEST_SEED: "1",
      GITHUB_E2E_EXCHANGE_TOKEN: TOKEN,
    });
    expect((await post()).statusCode).toBe(404);
  });

  it("404s when the flag is a TRUTHY string that is not the literal '1'", async () => {
    // env.ts keeps SUPAGLOO_ENABLE_TEST_SEED an uncoerced raw string precisely so
    // the gate can be `=== "1"` rather than truthiness (§9-Q9). "true" must NOT open
    // the route; a truthiness check here would be a silent widening of the seam.
    app = await buildOauthApp({
      NODE_ENV: "development",
      SUPAGLOO_ENABLE_TEST_SEED: "true",
      GITHUB_E2E_EXCHANGE_TOKEN: TOKEN,
    });
    expect((await post()).statusCode).toBe(404);
  });

  it("registers and answers GitHub's own success envelope when BOTH gates pass", async () => {
    app = await buildOauthApp({
      NODE_ENV: "development",
      SUPAGLOO_ENABLE_TEST_SEED: "1",
      GITHUB_E2E_EXCHANGE_TOKEN: TOKEN,
    });
    const res = await post();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Shape-for-shape what real GitHub answers, so `tokenResponseSchema` in
    // github-user-auth-client.ts parses it unchanged.
    expect(body).toEqual({
      access_token: TOKEN,
      token_type: "bearer",
      scope: "repo",
    });
  });

  it("registers OUTSIDE the /v1 scope — the client requests a fixed unversioned suffix", async () => {
    app = await buildOauthApp({
      NODE_ENV: "development",
      SUPAGLOO_ENABLE_TEST_SEED: "1",
      GITHUB_E2E_EXCHANGE_TOKEN: TOKEN,
    });
    expect((await post()).statusCode).toBe(200);
    // `exchangeCode` POSTs `${internalBase}/login/oauth/access_token` — a fixed
    // suffix with no version prefix — so a `/v1`-scoped registration could never be
    // reached at all.
    expect((await post("/v1/login/oauth/access_token")).statusCode).toBe(404);
  });

  it("requires NO session bearer (the double gate plus the absent token IS the protection)", async () => {
    // The route's whole purpose is to mint a credential, exactly as POST /v1/test/seed
    // mints a session — neither can require one.
    app = await buildOauthApp({
      NODE_ENV: "development",
      SUPAGLOO_ENABLE_TEST_SEED: "1",
      GITHUB_E2E_EXCHANGE_TOKEN: TOKEN,
    });
    const res = await app.inject({
      method: "POST",
      url: "/login/oauth/access_token",
      payload: exchangeBody,
      // deliberately no `authorization` header
    });
    expect(res.statusCode).toBe(200);
  });

  it("fails fast naming GITHUB_E2E_EXCHANGE_TOKEN when both gates pass but the token is absent", async () => {
    const err = await buildOauthApp({
      NODE_ENV: "development",
      SUPAGLOO_ENABLE_TEST_SEED: "1",
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GITHUB_E2E_EXCHANGE_TOKEN");
  });

  it("never answers with a placeholder token when the variable is absent", async () => {
    // The failure mode this forbids: a route that "helpfully" returns some fixed
    // string, so the spec goes green while `POST /user/repos` 401s far away.
    let built: FastifyInstance | undefined;
    try {
      built = await buildOauthApp({
        NODE_ENV: "development",
        SUPAGLOO_ENABLE_TEST_SEED: "1",
      });
    } catch {
      built = undefined;
    }
    expect(built, "registration must throw, not produce a usable app").toBeUndefined();
  });

  it("treats a blank value as absent and still fails fast naming the variable", async () => {
    // `GITHUB_E2E_EXCHANGE_TOKEN=` in a `.env` yields the empty string, not undefined,
    // and an empty bearer would 401 against real GitHub minutes later.
    const err = await buildOauthApp({
      NODE_ENV: "development",
      SUPAGLOO_ENABLE_TEST_SEED: "1",
      GITHUB_E2E_EXCHANGE_TOKEN: "   ",
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GITHUB_E2E_EXCHANGE_TOKEN");
  });
});
