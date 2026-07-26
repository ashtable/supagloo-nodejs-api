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
 * Three properties beyond the seed route's:
 *   • it registers OUTSIDE the `/v1` scope, because the client requests a fixed
 *     `/login/oauth/access_token` suffix with no version prefix;
 *   • an absent `GITHUB_E2E_EXCHANGE_TOKEN` FAILS FAST naming the variable. It must
 *     never return a placeholder and never silently disable itself — a spec that
 *     quietly stopped exercising the real exchange is a green lie;
 *   • it VERIFIES the posted `client_id`/`client_secret` against the App's configured
 *     pair before handing the credential back (round-4 review R5). Without that check
 *     the double gate alone means anyone who can reach the published `4000:4000` port
 *     gets a live GitHub token by POSTing an empty body — the handler did not even
 *     read the request. `exchangeCode` already sends both fields, so the check costs
 *     the real client nothing and turns "anyone who can reach the port" into "anyone
 *     who already holds the App client secret".
 */

const TOKEN = "github_pat_test_only_placeholder";
const CLIENT_ID = "Iv1.testclient";
const CLIENT_SECRET = "test-only-app-client-secret";

async function buildOauthApp(env: {
  NODE_ENV: "development" | "test" | "production";
  SUPAGLOO_ENABLE_TEST_SEED?: string;
  GITHUB_E2E_EXCHANGE_TOKEN?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
}): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerTestGithubOauthRoute(app, {
    env: {
      ...env,
      GITHUB_APP_CLIENT_ID: env.GITHUB_APP_CLIENT_ID ?? CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: env.GITHUB_APP_CLIENT_SECRET ?? CLIENT_SECRET,
    },
  });
  await app.ready();
  return app;
}

const exchangeBody = {
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
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

  it("requires NO session bearer (the App client secret, not a session, is the caller proof)", async () => {
    // The route's whole purpose is to mint a credential, exactly as POST /v1/test/seed
    // mints a session — neither can require one. What it DOES require is the App's own
    // OAuth client pair, which `exchangeCode` already sends (see the credential-check
    // block below).
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

describe("POST /login/oauth/access_token — the client-credential check (round-4 review R5)", () => {
  /**
   * WHY THIS EXISTS. Before it, the handler took no arguments at all: it discarded
   * the `client_id`/`client_secret` `exchangeCode` faithfully sends and answered
   * `{access_token: GITHUB_E2E_EXCHANGE_TOKEN}` to ANY caller. The api container
   * publishes `4000:4000` on all interfaces, so with the test overlay applied,
   * `curl -X POST localhost:4000/login/oauth/access_token` returned a LIVE GitHub
   * credential to anybody on the host's network.
   *
   * The double gate stays exactly as it is — it is correct, and the route cannot be
   * registered in production. This adds the second, orthogonal factor: the caller
   * must already hold the GitHub App's OAuth client secret. The real client sends it
   * on every exchange, so nothing about the product path changes.
   *
   * REJECTION SHAPE: real GitHub answers a bad client pair with **HTTP 200** and
   * `{"error":"incorrect_client_credentials", …}` — the same 200-with-error envelope
   * task-62 D18-2 discovered for `bad_verification_code`. Matching it means the
   * product's own `GithubUserAuthExchangeError` path handles a misconfiguration here,
   * with GitHub's own machine-readable code, instead of a test-only status branch.
   */
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  const enabled = {
    NODE_ENV: "development" as const,
    SUPAGLOO_ENABLE_TEST_SEED: "1",
    GITHUB_E2E_EXCHANGE_TOKEN: TOKEN,
  };

  const postBody = (payload: unknown) =>
    app!.inject({
      method: "POST",
      url: "/login/oauth/access_token",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });

  it("hands the token back ONLY when both client_id and client_secret match", async () => {
    app = await buildOauthApp(enabled);
    const res = await postBody(exchangeBody);
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBe(TOKEN);
  });

  it("refuses an EMPTY body — the pre-R5 handler answered this with a live token", async () => {
    app = await buildOauthApp(enabled);
    const res = await postBody({});
    const body = res.json();
    expect(body.access_token).toBeUndefined();
    expect(body.error).toBe("incorrect_client_credentials");
  });

  it("refuses a WRONG client_secret", async () => {
    app = await buildOauthApp(enabled);
    const res = await postBody({ ...exchangeBody, client_secret: "not-the-secret" });
    expect(res.json().access_token).toBeUndefined();
    expect(res.json().error).toBe("incorrect_client_credentials");
  });

  it("refuses a WRONG client_id even when the secret is right", async () => {
    app = await buildOauthApp(enabled);
    const res = await postBody({ ...exchangeBody, client_id: "Iv1.someoneelse" });
    expect(res.json().access_token).toBeUndefined();
    expect(res.json().error).toBe("incorrect_client_credentials");
  });

  it("refuses a body whose credential fields are the wrong TYPE", async () => {
    // `{client_secret: {}}` must not coerce its way past the comparison.
    app = await buildOauthApp(enabled);
    const res = await postBody({ client_id: 1, client_secret: {}, code: "c" });
    expect(res.json().access_token).toBeUndefined();
    expect(res.json().error).toBe("incorrect_client_credentials");
  });

  it("leaks NEITHER the exchange token NOR the configured secret in the refusal", async () => {
    app = await buildOauthApp(enabled);
    const raw = (await postBody({ ...exchangeBody, client_secret: "wrong" })).body;
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(CLIENT_SECRET);
  });

  it("answers a rejected pair with GitHub's own 200-with-error envelope", async () => {
    // Shape-for-shape GitHub, so `exchangeCode`'s existing error branch produces a
    // typed GithubUserAuthExchangeError with `code: "incorrect_client_credentials"`
    // rather than an anonymous parse failure. No test-only branch in product code.
    app = await buildOauthApp(enabled);
    const res = await postBody({ ...exchangeBody, client_secret: "wrong" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([
      "error",
      "error_description",
      "error_uri",
    ]);
    expect(body.error_description).toBeTypeOf("string");
  });

  it("still hard-404s on a wrong pair when the gates are closed (the gate is checked FIRST)", async () => {
    // The credential check must never become a way to probe whether the route exists:
    // gates closed ⇒ no registration ⇒ Fastify's own not-found, identical for a right
    // pair and a wrong one.
    app = await buildOauthApp({ ...enabled, SUPAGLOO_ENABLE_TEST_SEED: undefined });
    expect((await postBody(exchangeBody)).statusCode).toBe(404);
    expect((await postBody({})).statusCode).toBe(404);
  });
});
