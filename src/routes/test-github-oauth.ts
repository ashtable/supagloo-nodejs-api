import type { FastifyInstance } from "fastify";

export interface TestGithubOauthDeps {
  /** Only the two gate fields plus the test-only credential (§9-Q9, plan row 66). */
  env: {
    NODE_ENV: "development" | "test" | "production";
    SUPAGLOO_ENABLE_TEST_SEED?: string;
    GITHUB_E2E_EXCHANGE_TOKEN?: string;
  };
}

/** The variable named in the fail-fast, authored once so the message and the schema
 *  key cannot drift. */
export const GITHUB_E2E_EXCHANGE_TOKEN_VAR = "GITHUB_E2E_EXCHANGE_TOKEN";

/**
 * The flag-gated, TEST-ONLY user-authorization token exchange (plan row 66).
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * The create-new-repo flow (wireframe 12a) runs: browser → github.com consent →
 * GitHub hands us a `code` → **the api trades that code for a user token** →
 * `POST /user/repos` → the scaffold workflow. Only that fourth hop is unreachable
 * from a browser spec: it is a SERVER-side call made inside the containerised api,
 * and a real `code` cannot be manufactured (real GitHub answers
 * `bad_verification_code`; the retired github-stub accepted any non-empty string,
 * which is the only reason a synthetic code ever "worked").
 *
 * The api repo's own e2e intercepts that hop at the in-process `fetchImpl` seam. A
 * CONTAINERISED api has no such seam — which is why, before this route, the entire
 * 11-hop browser round trip shipped un-exercised against real GitHub (§11.4 tier 2,
 * a reported deviation). With `GITHUB_OAUTH_INTERNAL_BASE_URL=http://api:4000` the
 * api makes that one call to ITSELF over the Compose network and this route answers
 * it. Deliberately NO new container: §10.7 "keeping dead stubs invites quiet
 * re-adoption" and §10.9 "reintroducing stubs is not a mitigation".
 *
 * ── WHY THIS IS NOT A STUB ───────────────────────────────────────────────────
 * Everything after the exchange is real: `POST /user/repos` really creates a repo on
 * github.com under the returned token, and the whole scaffold runs against it. What
 * is substituted is the token's PROVENANCE, exactly the §10.2 exception already used
 * for the YouVersion sign-in and the OpenRouter PKCE hop — an interactive browser
 * login, and only that hop.
 *
 * ── THE PROTECTION ───────────────────────────────────────────────────────────
 * EXACTLY the `POST /v1/test/seed` double gate (§9-Q9): `NODE_ENV !== 'production'`
 * AND `SUPAGLOO_ENABLE_TEST_SEED === '1'` — the LITERAL '1', not truthiness, which is
 * why `env.ts` keeps that flag an uncoerced raw string. A failed gate means the route
 * is NEVER REGISTERED, so Fastify's own not-found handler answers exactly as for any
 * unknown path (never a 401/403, which would leak that the route exists).
 *
 * No session bearer, for the same reason `POST /v1/test/seed` cannot require one: the
 * route's whole purpose is to hand back a credential. The double gate plus the fact
 * that a production image holds no `GITHUB_E2E_EXCHANGE_TOKEN` at all IS the
 * protection.
 *
 * ── REGISTRATION SITE ────────────────────────────────────────────────────────
 * OUTSIDE the `/v1` scope, alongside `registerHealthRoutes`. Not a style choice:
 * `exchangeCode` requests a fixed `${base}/login/oauth/access_token` suffix with no
 * version prefix, because that is GitHub's own URL shape.
 */
export function registerTestGithubOauthRoute(
  app: FastifyInstance,
  deps: TestGithubOauthDeps,
): void {
  const enabled =
    deps.env.NODE_ENV !== "production" &&
    deps.env.SUPAGLOO_ENABLE_TEST_SEED === "1";
  if (!enabled) return;

  const token = deps.env.GITHUB_E2E_EXCHANGE_TOKEN?.trim();
  if (!token) {
    // FAIL FAST, naming the variable. Never a placeholder and never a silent
    // self-disable: a route that returned some fixed string would let the browser
    // spec go green while `POST /user/repos` 401s minutes later, and a route that
    // quietly declined to register would turn "the real exchange stopped being
    // exercised" into a passing suite. Both are green lies.
    throw new Error(
      `The test-only GitHub token-exchange route is ENABLED ` +
        `(NODE_ENV=${deps.env.NODE_ENV}, SUPAGLOO_ENABLE_TEST_SEED='1') but ` +
        `${GITHUB_E2E_EXCHANGE_TOKEN_VAR} is missing or blank, so it has no user ` +
        `token to hand back. Set ${GITHUB_E2E_EXCHANGE_TOKEN_VAR} in the ROOT ` +
        `supagloo checkout's untracked .env — the container receives it by ` +
        `\${${GITHUB_E2E_EXCHANGE_TOKEN_VAR}} substitution; see .env.example for how ` +
        `to mint it (a fine-grained token with repository-creation rights only, and ` +
        `deliberately no delete_repo). Refusing to start with a placeholder: a spec ` +
        `that silently stopped exercising the real exchange is a green lie. If you ` +
        `did not mean to enable this route at all, unset SUPAGLOO_ENABLE_TEST_SEED.`,
    );
  }

  app.post("/login/oauth/access_token", async () => {
    // Real GitHub's success envelope, shape-for-shape, so `tokenResponseSchema` in
    // `github-user-auth-client.ts` parses it with no test-only branch in product code.
    // The token itself is NEVER logged.
    return { access_token: token, token_type: "bearer", scope: "repo" };
  });
}
