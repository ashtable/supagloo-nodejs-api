import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export interface TestGithubOauthDeps {
  /**
   * The two gate fields, the test-only credential (§9-Q9, plan row 66), and the
   * App's own OAuth client pair — which the route compares the POSTed pair against
   * (round-4 review R5). The client pair is REQUIRED here, not optional: `env.ts`
   * makes both `z.string().min(1)`, so a boot that reaches this route always has
   * them, and an optional field would invite a fail-open branch.
   */
  env: {
    NODE_ENV: "development" | "test" | "production";
    SUPAGLOO_ENABLE_TEST_SEED?: string;
    GITHUB_E2E_EXCHANGE_TOKEN?: string;
    GITHUB_APP_CLIENT_ID: string;
    GITHUB_APP_CLIENT_SECRET: string;
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
 * ── THE PROTECTION: TWO INDEPENDENT FACTORS ──────────────────────────────────
 * 1. THE DOUBLE GATE — EXACTLY `POST /v1/test/seed`'s (§9-Q9): `NODE_ENV !==
 *    'production'` AND `SUPAGLOO_ENABLE_TEST_SEED === '1'` — the LITERAL '1', not
 *    truthiness, which is why `env.ts` keeps that flag an uncoerced raw string. A
 *    failed gate means the route is NEVER REGISTERED, so Fastify's own not-found
 *    handler answers exactly as for any unknown path (never a 401/403, which would
 *    leak that the route exists). A production image holds neither the gates nor the
 *    credential.
 *
 * 2. THE CLIENT-CREDENTIAL CHECK (round-4 review R5) — the POSTed `client_id` and
 *    `client_secret` must equal the App's configured pair, compared with a
 *    length-independent timing-safe comparison. This was missing: the handler took
 *    no arguments at all, discarding the pair `exchangeCode` faithfully sends, and
 *    returned the live credential to ANY caller. The api container publishes
 *    `4000:4000` on every interface, so with the test overlay applied a bare
 *    `curl -X POST localhost:4000/login/oauth/access_token` was a live GitHub token.
 *    The check costs the real client nothing — it already sends both fields — and it
 *    turns "anyone who can reach the port" into "anyone who already holds the App's
 *    OAuth client secret", which is itself a deployment secret.
 *
 * There is still NO session bearer, for the same reason `POST /v1/test/seed` cannot
 * require one: the route's whole purpose is to hand back a credential, so it cannot
 * presuppose one. The App client secret is the caller proof instead.
 *
 * NOTHING here is ever logged: not the exchange token, not the configured secret,
 * not the submitted one. The refusal body is a fixed GitHub-shaped envelope that
 * echoes no input.
 *
 * ── THE CREDENTIAL ITSELF, ACCURATELY ────────────────────────────────────────
 * `GITHUB_E2E_EXCHANGE_TOKEN` is the ONE GitHub credential that enters a product
 * container. Earlier revisions of this docblock (and five other documents) called it
 * a fine-grained token with "repository-creation rights only" and "deliberately no
 * `delete_repo`". **That was not achievable and is not what is deployed.** Any token
 * that can create repositories on an account can also delete them: fine-grained
 * `Administration: write` is the SAME permission `DELETE /repos/{owner}/{repo}`
 * requires, and `delete_repo` is a CLASSIC-PAT-only scope, so "no `delete_repo`" is a
 * no-op phrase for a fine-grained token. There is no create-without-delete GitHub
 * credential to mint. The value actually deployed is a classic PAT with the broad
 * `repo` scope.
 *
 * The honest mitigations are therefore: the double gate above; the credential being
 * READ only under the test overlay (a plain `docker compose up` never sets the flag,
 * so the route is not registered and the variable is never read); the client-secret
 * check; and `GITHUB_E2E_PAT_TOKEN` still entering no container at all. The residual
 * risk is real and recorded in design-delta §11.8: a broadly-scoped GitHub credential
 * for an account that also holds real repositories sits in a container's environment
 * whenever the test overlay is up. The mitigation that would actually shrink the blast
 * radius is a dedicated throwaway/bot account (§11.9's named exit), not a narrower
 * scope — no narrower scope exists.
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
        `\${${GITHUB_E2E_EXCHANGE_TOKEN_VAR}} substitution; see .env.example for ` +
        `which credential it is and what it can actually do. Refusing to start with ` +
        `a placeholder: a spec that silently stopped exercising the real exchange is ` +
        `a green lie. If you did not mean to enable this route at all, unset ` +
        `SUPAGLOO_ENABLE_TEST_SEED.`,
    );
  }

  const expectedClientId = deps.env.GITHUB_APP_CLIENT_ID;
  const expectedClientSecret = deps.env.GITHUB_APP_CLIENT_SECRET;

  // Only the two credential fields matter here. `code` is deliberately NOT validated:
  // a real authorization code cannot be manufactured in a test lane, which is the
  // whole reason this route exists, so requiring a plausible one would be theatre.
  const credentialsSchema = z.object({
    client_id: z.string(),
    client_secret: z.string(),
  });

  app.post("/login/oauth/access_token", async (request) => {
    const posted = credentialsSchema.safeParse(request.body);
    const ok =
      posted.success &&
      constantTimeEquals(posted.data.client_id, expectedClientId) &&
      constantTimeEquals(posted.data.client_secret, expectedClientSecret);

    if (!ok) {
      // Real GitHub's OWN rejection: HTTP **200** with an `error` envelope, the same
      // 200-with-error shape task-62 D18-2 found for `bad_verification_code`. Matching
      // it means a misconfigured lane surfaces as the product's typed
      // `GithubUserAuthExchangeError` carrying GitHub's machine-readable code, with no
      // test-only status branch in `github-user-auth-client.ts`. The body is FIXED — it
      // echoes nothing that was submitted and names neither secret.
      return {
        error: "incorrect_client_credentials",
        error_description:
          "The client_id and/or client_secret passed are incorrect.",
        error_uri:
          "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#incorrect-client-credentials",
      };
    }

    // Real GitHub's success envelope, shape-for-shape, so `tokenResponseSchema` in
    // `github-user-auth-client.ts` parses it with no test-only branch in product code.
    // The token itself is NEVER logged.
    return { access_token: token, token_type: "bearer", scope: "repo" };
  });
}

/**
 * Length-independent constant-time string comparison.
 *
 * `timingSafeEqual` THROWS on a length mismatch, and that throw is itself an oracle
 * for the configured value's length — so both sides are hashed to a fixed 32-byte
 * digest first and the digests are compared. Neither input is logged, and no branch
 * short-circuits on a prefix match.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}
