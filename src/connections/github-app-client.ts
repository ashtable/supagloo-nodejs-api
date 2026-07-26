import { z } from "zod";
import {
  signAppJwt,
  mintInstallationToken,
  withGithubRetry,
  GithubAppError,
  DEFAULT_GITHUB_MAX_ATTEMPTS,
  type GithubRepo,
} from "@supagloo/database-lib";

/**
 * GitHub App HTTP client (design-delta §2.3/§6a). Mirrors `auth/youversion.ts`:
 * an injectable `fetch`, closures over the app config, unit-tested with hand-built
 * `Response` objects (no mocking library). It wraps db-lib's shared primitives:
 *   - `verifyInstallation` signs an **App JWT** and calls `GET
 *     /app/installations/:id` (used once at connect time to confirm the install).
 *   - `listInstallationRepos` mints a **fresh installation token** per call
 *     (`mintInstallationToken`) and lists `GET /installation/repositories` with
 *     it — never cached, never stored.
 *   - `getRepositoryFileContents` mints a **fresh installation token** per call
 *     and reads a single file via `GET /repos/:owner/:repo/contents/:path?ref=`
 *     (the manifest read, task 20), base64-decoding the returned content.
 */

export interface VerifiedInstallation {
  githubLogin: string;
  repositorySelection: string;
}

/** A single file read from the GitHub Contents API. `content` is the DECODED
 *  UTF-8 text (the transport-level base64 is undone here); `sha` is the blob SHA. */
export interface GithubFileContents {
  content: string;
  sha: string;
  path: string;
}

export interface GithubAppClient {
  verifyInstallation(installationId: string): Promise<VerifiedInstallation | null>;
  listInstallationRepos(args: {
    installationId: string;
    /**
     * Which repos — if any — the caller needs an **authoritative** `empty` verdict
     * for (plan row 65's commits probe). **Omitted ⇒ NO probe is issued at all**,
     * and `empty` carries only the provisional `size === 0` reading.
     *
     * The probe is one extra GitHub request per candidate, so it is priced per
     * CALLER rather than per listing (deferred review finding DR2). Callers that
     * merely count repos, or that render `empty` as an ungated label, pass nothing
     * and pay nothing; the picker tab that GATES on `empty` passes a predicate
     * selecting exactly the rows it will show. See the request-budget note on
     * {@link EMPTINESS_PROBE_CONCURRENCY} for the measured cost of each.
     *
     * The predicate can only NARROW: a `size > 0` repo is already definitive and is
     * never probed regardless of what this admits.
     */
    deriveEmptinessFor?: (repo: GithubRepo) => boolean;
  }): Promise<GithubRepo[]>;
  /** Read a single file at `ref` via the Contents API. Returns `null` when GitHub
   *  404s (repo / branch / file absent); throws on any other non-2xx. */
  getRepositoryFileContents(args: {
    installationId: string;
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<GithubFileContents | null>;
}

export interface MakeGithubAppClientOptions {
  apiBaseUrl: string;
  appId: string;
  /** PKCS#1/PKCS#8 PEM. An escaped-`\n` value (common in env config) is restored. */
  privateKey: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Injectable sleep for the bounded rate-limit backoff (plan row 64). Defaults to a
   * real timer in production; the unit lane passes a recording spy so nothing ever
   * actually waits (design-delta §10.6 — unit suites keep every stub, no real egress
   * and no real clock). Threaded into db-lib's `withGithubRetry` AND into
   * `mintInstallationToken`, which does its own retry internally.
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Attempts per request, including the first. Defaults to db-lib's
   * `DEFAULT_GITHUB_MAX_ATTEMPTS` (4) — the budget sized for DBOS workflows.
   * See {@link makeInteractiveGithubAppClient} for why a browser-facing caller
   * must not use that default.
   */
  maxAttempts?: number;
  /**
   * Total in-request **sleeping** permitted across ONE client call — one
   * `listInstallationRepos` (its mint + every page), one `getRepositoryFileContents`
   * (its mint + the read), one `verifyInstallation`. Unset ⇒ unbounded, which is
   * db-lib's behaviour and the right one for a durable workflow step.
   *
   * It is a shared wall clock, not a per-request cap, and that is the whole point:
   * see {@link makeInteractiveGithubAppClient}.
   */
  retryBudgetMs?: number;
}

/**
 * Attempts per request for the API's own, browser-facing client.
 *
 * db-lib's default is 4 (a durable DBOS step can afford to be patient). A page load
 * cannot: there is a human waiting, and the repo picker degrades to a retryable error
 * far better than to a tab that hangs. One retry absorbs the single-blip case — which
 * is what retry is actually for on an interactive route — and stops there.
 */
export const INTERACTIVE_GITHUB_MAX_ATTEMPTS = 2;

/**
 * Total in-request sleeping the API's client may spend on ONE call, shared across
 * the mint and every page of a listing.
 *
 * Sized against the request it protects: `GET /v1/github/repos` is a page-load path,
 * so ten seconds of backoff is already at the edge of what a user will read as
 * "loading" rather than "broken". It is deliberately far below db-lib's 60 s
 * per-sleep cap, because that cap bounds ONE sleep and this bounds the whole call.
 */
export const INTERACTIVE_GITHUB_RETRY_BUDGET_MS = 10_000;

/**
 * A non-2xx GitHub response on one of this client's own requests (plan row 64).
 *
 * Until this row the three failure sites here threw a bare `new Error` carrying only a
 * status embedded in a message string, so nothing downstream could classify an upstream
 * throttle apart from an upstream outage without re-parsing English.
 *
 * **Why the upstream status is `upstreamStatus` and NOT `status`.** Fastify's default
 * error handler prefers `error.status` over `error.statusCode`
 * (`fastify/lib/error-handler.js`, `setErrorHeaders`: `if (error.status >= 400)
 * statusCode = error.status`). An error field literally named `status` would therefore
 * become the HTTP reply code of whatever route the throw escapes through — turning a
 * GitHub 401 (our App credential is wrong) into a **401 to the browser**, which the web
 * client reads as "your session expired" and logs the user out on an infrastructure
 * fault. The upstream value is deliberately carried under a name Fastify does not
 * consume, and `statusCode = 502` states what the API should actually answer: the
 * upstream failed, not the caller. Same split as `RepoCreationError.upstreamStatus`.
 */
export class GithubAppRequestError extends Error {
  /** The HTTP status GitHub answered with. Never the status WE reply. */
  readonly upstreamStatus: number;
  /** The status this API replies when the error escapes a route: Bad Gateway. */
  readonly statusCode = 502;
  constructor(message: string, opts: { upstreamStatus: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "GithubAppRequestError";
    this.upstreamStatus = opts.upstreamStatus;
  }
}

/** The HTTP status every route replies for an upstream GitHub failure, and the error
 *  slug that rides with it. Exported so the routes and their tests name ONE constant
 *  rather than three copies of the literal. */
export const GITHUB_UPSTREAM_STATUS = 502;
export const GITHUB_UPSTREAM_ERROR_SLUG = "github_upstream_failed";

/**
 * Is `err` a failure of GitHub itself, from either side of the db-lib boundary?
 *
 * **The rule this predicate exists to enforce: a provider error class must never be
 * able to dictate our HTTP status.** Fastify's default error handler derives the reply
 * status from the thrown error (`error.status`, then `error.statusCode` — see
 * {@link GithubAppRequestError}'s doc-comment), so anything escaping a route handler
 * answers the browser with whatever fields it happens to carry.
 *
 * Naming the upstream status `upstreamStatus` avoids that trap only for as long as
 * every class involved remembers to. db-lib's {@link GithubAppError} did NOT: it named
 * the field `status` (fixed in the row 63-68 follow-up), and `mintInstallationToken`
 * throws it uncaught out of BOTH `listInstallationRepos` and
 * `getRepositoryFileContents` — i.e. out of `GET /v1/github/repos` AND
 * `GET /v1/projects/:id/manifest`. A GitHub 401 on the token exchange therefore became
 * our own 401 — telling the caller to re-authenticate, indistinguishable from a real
 * session expiry, when the caller's session was fine and OUR credential was the broken
 * one. A 404 became a spurious not-found. Infrastructure faults reported as caller
 * faults, on the two routes the studio and the repo picker depend on.
 *
 * So the routes catch by CLASS and choose the status themselves. That is defence in
 * depth, deliberately redundant with the field naming: the naming convention lives in
 * another repo and can be reverted by a one-word change invisible from here, whereas
 * this catch holds whatever any provider error is named.
 *
 * UPDATED 2026-07-26: the app now registers a `setErrorHandler` (`src/error-handler.ts`)
 * that ignores `error.status` entirely — an error carrying its status only under that name
 * is generified to a 500. That is a THIRD, independent layer beneath this one, and it is
 * strictly weaker: it can only choose between "some status" and 500, whereas this predicate
 * is what makes the reply a *correct* 502 carrying `github_upstream_failed`. Both stay.
 *
 * `RATE_LIMITED` folds in with the rest: a throttle that never cleared inside the
 * bounded retry budget is, to the caller, an upstream failure like any other.
 */
export function isUpstreamGithubError(
  err: unknown,
): err is GithubAppRequestError | GithubAppError {
  return err instanceof GithubAppRequestError || err instanceof GithubAppError;
}

const installationSchema = z.object({
  account: z.object({ login: z.string() }),
  repository_selection: z.string(),
});

const repoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  default_branch: z.string(),
  // GitHub reports `size` in KILOBYTES and computes it ASYNCHRONOUSLY, so it lags
  // UPWARD: a just-created repo — including one with a single small README commit
  // from `auto_init: true` — reports 0, and so can a repo that already has real
  // content. `size` is therefore only HALF the emptiness verdict: `size > 0` is
  // definitive (it never overstates), `size === 0` is merely a CANDIDATE that the
  // commits probe resolves. See the derivation note below.
  size: z.number(),
});
const reposResponseSchema = z.object({
  repositories: z.array(repoSchema),
});

// The GitHub Contents API file response (design-delta §5.3). A file (not a
// directory) is returned base64-encoded; the manifest is a tiny file so it is
// always `encoding:"base64"` (the `"none"` >1MB blob-API path never applies).
const fileContentsSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string(),
  sha: z.string(),
  path: z.string(),
});

/**
 * GitHub paginates via an RFC 5988 `Link` header; the canonical way to walk a
 * listing is to follow the `rel="next"` URL until the server stops emitting one
 * (the same mechanism Octokit uses). Returns the absolute next-page URL, or
 * `null` when this is the last page — which is what guarantees termination.
 */
function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  const match = link.match(/<([^>]+)>\s*;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * How many emptiness probes may be in flight at once (plan row 65 / D65.3).
 *
 * **The measured request budget, PER CALLER** (live installation, 2026-07-26:
 * `repository_selection: "all"`, 582 visible repos over 6 pages, 55 of them
 * `size: 0`; the installation's primary limit is ~5,000 requests/hour):
 *
 * | call | probes | total |
 * |---|---|---|
 * | `GET /v1/github/repos` (no `filter`, no `q`) | 0 | **7** |
 * | `?filter=empty` — wireframe 13a's picker tab | ≤55 | ~62 |
 * | `?filter=empty&q=<name>` | 1 | 8 |
 *
 * The first row is the one that matters, and it is why the probe is opt-in
 * (`deriveEmptinessFor`, deferred review finding DR2). `GET /v1/github/repos` is
 * **not only the repo picker**: nextjs's `SessionProvider` calls it on every hard
 * page load of every page in the app, unfiltered, purely to render an "N repos
 * accessible" count — a caller that never reads `empty`. Probing there cost ~62
 * requests per page load, i.e. **~80 page loads to exhaust the hourly budget**,
 * down from ~700. And the listing GETs — unlike the probes — THROW on exhaustion,
 * so hitting the limit failed the picker outright instead of degrading it.
 *
 * The second row is the fan-out this constant exists to bound. It is genuinely
 * earned — 13a GATES its rows on `empty` — and it is paid once, when the user opens
 * that tab. Probing unconditionally instead of only the `size === 0` subset would
 * make it 582 requests in a burst, straight into GitHub's secondary rate limit. 8
 * keeps the wall clock close to unbounded-parallel while staying far under any abuse
 * threshold.
 *
 * Exported so the unit test asserts the ACTUAL ceiling rather than a copy of it.
 */
export const EMPTINESS_PROBE_CONCURRENCY = 8;

/**
 * Is `owner/repo` empty, according to GitHub's commit list?
 *
 * `GET /repos/:o/:r/commits?per_page=2` is the cheapest authoritative answer
 * (task-62 D16):
 *   - **409** — real GitHub's `"Git Repository is empty."` for a repo with no
 *     commits at all. 409 has no other meaning on this endpoint.
 *   - **200 with ≤1 commit** ⇒ empty. This is the `auto_init` README case, and it is
 *     deliberate: a repo whose entire history is the single commit GitHub itself
 *     created is still a valid scaffold target (wireframe 13a's selectable
 *     "Empty · created just now"). Every fixture repo in the e2e system is exactly
 *     this shape, and the whole nextjs `test:e2e:real` lane acquires its project
 *     through that picker row.
 *   - **200 with ≥2 commits** ⇒ NOT empty. Two commits means somebody other than
 *     `auto_init` has written to it.
 *
 * Returns `null` for **UNKNOWN** — any other status, an unparseable body, or a
 * transport failure. The caller then keeps the `size`-derived verdict, which
 * strictly dominates the pre-probe behaviour: a probe that cannot answer can never
 * make the listing worse than it was before probes existed. Failing closed instead
 * (`empty: false`) would hide a genuinely empty repo from the picker on one
 * transient blip — and the picker is the sole project-acquisition path for the
 * entire real-GitHub browser lane.
 *
 * **Deliberately NOT wrapped in `withGithubRetry` (plan row 64).** Every other request
 * this client makes is retried on a throttle, because its caller has no fallback — a
 * failed mint or a failed page means no listing at all. The probe is the one request
 * that *does* have a defined fallback (the `size` verdict, immediately above), and it is
 * simultaneously the one most likely to trip a secondary limit: it fans out over every
 * `size: 0` candidate the caller asked about (measured 2026-07-26: 55 candidates for an
 * unnarrowed `?filter=empty`). Retrying it would convert one throttled picker open into
 * `ceil(55/8) x 3 x 60s` of in-request sleeping to obtain an answer we already have a
 * safe default for. **The rule: retry what you cannot fall back from; degrade what you
 * can.** Pinned by its own named unit test.
 */
async function probeRepoEmpty(args: {
  apiBaseUrl: string;
  owner: string;
  repo: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}): Promise<boolean | null> {
  const { apiBaseUrl, owner, repo, headers, fetchImpl } = args;
  try {
    const res = await fetchImpl(
      `${apiBaseUrl}/repos/${owner}/${repo}/commits?per_page=2`,
      { method: "GET", headers },
    );
    if (res.status === 409) return true;
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return null;
    return body.length <= 1;
  } catch {
    // A transport failure is UNKNOWN, never a verdict — and never fatal to the
    // listing, which must still return every repo it successfully read.
    return null;
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Deliberately a local
 * ~10-line pool rather than a dependency: the only concurrency this client has ever
 * needed is this one, and `Promise.all` over an unbounded map is exactly the
 * fan-out `EMPTINESS_PROBE_CONCURRENCY` exists to prevent.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
}

/**
 * Restore a PEM whose newlines were escaped to the literal two-char `\n` (as
 * env vars often carry multi-line secrets). A real multi-line PEM is unchanged.
 *
 * NOTE (task-62): this is now REDUNDANT with db-lib's `normalizePemNewlines`, which
 * `signAppJwt` and `mintInstallationToken` apply themselves (db-lib
 * `src/github.ts:93-105`, the row-62 item (c) fix). It is harmless — db-lib's
 * replacement is a no-op on an already-restored key, and both are idempotent — and it
 * is deliberately LEFT IN PLACE here rather than deleted in this task: removing it
 * would make every JWT in this client depend solely on a db-lib version pin, which is
 * a change that belongs with a db-lib release, not with an e2e-harness task (task-62
 * D2 forbids touching db-lib at all). db-lib's version is the strictly more thorough
 * one (it also folds real CRLF and trims), so behaviour is unchanged either way.
 *
 * Recorded as a known duplication: THREE harness-visible PEM normalisations now exist
 * (db-lib's, root's `signAppJwtLocal`, and this one). The property that actually
 * matters — that the escaped and real forms produce a byte-identical signature — is
 * fenced by a unit test in root (task-62 D3).
 */
function normalizePrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

export function makeGithubAppClient(
  options: MakeGithubAppClientOptions,
): GithubAppClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  const privateKey = normalizePrivateKey(options.privateKey);
  const appId = options.appId;
  const baseSleep =
    options.sleepImpl ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts;
  const retryBudgetMs = options.retryBudgetMs ?? Number.POSITIVE_INFINITY;

  const jsonHeaders = (auth: string) => ({
    authorization: auth,
    accept: "application/vnd.github+json",
  });

  /**
   * One shared sleep budget for one whole client call (deferred review finding DR3).
   *
   * Row 64 wrapped each request in its own independent `withGithubRetry`, so a
   * listing's worst-case wall clock was `(1 mint + N pages) x (maxAttempts - 1) x 60s`
   * — it scaled with the size of the user's account, on a route with a browser
   * connection held open behind it. A budget created once per call and threaded into
   * every request underneath it makes the worst case a property of the ROUTE instead.
   *
   * It bounds SLEEPING, not attempts: once the budget is spent the remaining attempts
   * still fire, they just fire immediately. That is deliberate — `maxAttempts` is the
   * thing that bounds requests, and conflating the two would make an exhausted budget
   * silently change the retry semantics db-lib owns.
   */
  const newRetryBudget = () => {
    let remaining = retryBudgetMs;
    return async (ms: number) => {
      const wait = Math.max(0, Math.min(ms, remaining));
      remaining -= wait;
      await baseSleep(wait);
    };
  };

  /**
   * Every request whose failure this client CANNOT fall back from goes through here
   * (plan row 64 / D64.1, D64.2). db-lib's `withGithubRetry` is the single shared
   * implementation (§11.7 "one implementation, four consumers"): it honours GitHub's own
   * `Retry-After` / `x-ratelimit-reset` with a bounded, capped backoff, retries `429` and
   * `5xx`, and — critically — does NOT retry a bare `403`, which for this installation is
   * a genuine permission denial (§11.3: it deliberately holds no `administration` scope)
   * rather than a throttle. It RETURNS the final `Response` and never throws, so each
   * call site below still mints its own typed error from it.
   *
   * `sleep` is the CALL's budget (see {@link newRetryBudget}), not a fresh one per
   * request — passing a new one here would restore exactly the multiplication DR3 named.
   *
   * `fn` must issue a FRESH request every call — never hand it a `Response`.
   */
  const retrying = (
    fn: () => Promise<Response>,
    sleep: (ms: number) => Promise<void>,
  ) => withGithubRetry(fn, { sleepImpl: sleep, maxAttempts });

  return {
    async verifyInstallation(installationId) {
      const sleep = newRetryBudget();
      const jwt = signAppJwt({ appId, privateKey });
      const res = await retrying(
        () =>
          fetchImpl(`${apiBaseUrl}/app/installations/${installationId}`, {
            method: "GET",
            headers: jsonHeaders(`Bearer ${jwt}`),
          }),
        sleep,
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new GithubAppRequestError(
          `GitHub installation verify failed for ${installationId}: ${res.status}`,
          { upstreamStatus: res.status },
        );
      }
      const raw = installationSchema.parse(await res.json());
      return {
        githubLogin: raw.account.login,
        repositorySelection: raw.repository_selection,
      };
    },

    async listInstallationRepos({ installationId, deriveEmptinessFor }) {
      // ONE budget for the mint AND every page below it (DR3).
      const sleep = newRetryBudget();
      // Mint ONCE per listing (the "fresh-token-per-call, never store" invariant
      // is per `listInstallationRepos` call) and reuse it across every page.
      const { token } = await mintInstallationToken({
        appId,
        privateKey,
        installationId,
        apiBaseUrl,
        fetchImpl,
        // db-lib retries the exchange itself; pass the CALL's budgeted sleep through so
        // the unit lane never really waits and the deadline spans the exchange too
        // (plan row 64 + DR3).
        sleepImpl: sleep,
        maxAttempts,
      });
      const headers = jsonHeaders(`token ${token}`);

      // Walk ALL pages. `per_page=100` is GitHub's max; then we follow the
      // `Link: rel="next"` URL verbatim until the server omits it. A single
      // unpaginated fetch would silently truncate any installation with more
      // repos than fit on one page (their target repo simply vanishing from the
      // picker with no error) — the bug this method guards against.
      const collected: z.infer<typeof repoSchema>[] = [];
      let nextUrl: string | null = `${apiBaseUrl}/installation/repositories?per_page=100`;
      while (nextUrl) {
        const url = nextUrl;
        const res = await retrying(
          () => fetchImpl(url, { method: "GET", headers }),
          sleep,
        );
        if (!res.ok) {
          // A page that never clears fails the WHOLE listing. Never `break` here: a
          // partial listing is a silent failure — the user's repo simply missing from
          // the picker — which is strictly worse than a loud one.
          throw new GithubAppRequestError(
            `GitHub installation repos list failed for ${installationId}: ${res.status}`,
            { upstreamStatus: res.status },
          );
        }
        const raw = reposResponseSchema.parse(await res.json());
        collected.push(...raw.repositories);
        nextUrl = parseNextLink(res.headers.get("link"));
      }

      // ─────────────────────────── EMPTINESS DERIVATION (plan row 65) ────────────
      //
      // WHY `size` alone is not enough. GitHub reports `size` in KB, rounded, and
      // computes it ASYNCHRONOUSLY, so it lags UPWARD: it can read 0 for a repo that
      // already has content, but it never overstates. The realistic failure is
      // therefore a false `empty: true`, whose blast radius is wireframe 13a offering
      // an already-populated repo as a scaffold target with its `data-disabled` gate
      // lifted — a SILENT failure (a picker row whose click is a no-op, surfacing much
      // later as an opaque timeout).
      //
      // THE RULE (task-62 D16 — the algorithm this comment used to describe as a
      // deferred contingency, now implemented):
      //   • `size > 0`   ⇒ definitively NOT empty. NO probe. `size` never overstates,
      //                    so a positive reading is trustworthy on its own.
      //   • `size === 0` ⇒ AMBIGUOUS. Probe `GET /repos/:o/:r/commits?per_page=2`:
      //        409 ("Git Repository is empty.") ⇒ empty
      //        200 with ≤1 commit               ⇒ empty
      //        200 with ≥2 commits              ⇒ NOT empty
      //        anything else                    ⇒ UNKNOWN ⇒ keep the `size` verdict
      //
      // WHY "≤1 commit ⇒ empty" rather than "any ref/commit ⇒ not empty". A repo whose
      // entire history is the one commit `auto_init: true` created is still a valid
      // scaffold target, and that is the designed 13a state "Empty · created just now".
      // Plan row 65's own wording ("a repo with size:0 but a non-empty REF LIST is NOT
      // reported empty") would flip EVERY `auto_init` repo to `empty: false` — which is
      // every fixture repo in the e2e system, and every repo the product itself creates
      // since plan row 63 started sending `auto_init: true`. That would disable the one
      // picker row the whole nextjs `test:e2e:real` lane acquires its project through.
      // The row's wording is defective; this is the corrected rule.
      //
      // REQUEST BUDGET. `GET /v1/github/repos` is NOT only the repo picker — nextjs's
      // `SessionProvider` calls it on every hard page load to render a repo COUNT — and
      // the live installation is `repository_selection: "all"` (measured 2026-07-26: 582
      // repos, 6 pages, 55 of them `size: 0`, against a ~5,000/hour limit). So the probe
      // is deliberately
      // (a) NOT ISSUED AT ALL unless the caller passed `deriveEmptinessFor`, i.e. said it
      //     will actually read `empty` (deferred review finding DR2 — this is what makes a
      //     page load cost 7 requests instead of ~62),
      // (b) restricted to the repos that predicate admits, so a query narrowed to one
      //     repo costs one probe rather than 55,
      // (c) skipped entirely when there are no `size === 0` candidates — which is what
      //     preserves task-62 D9's "two listings ⇒ exactly TWO mints and TWO listing GETs"
      //     budget assertion — and
      // (d) at most ONE request per candidate, bounded by EMPTINESS_PROBE_CONCURRENCY.
      // It reuses the ONE installation token minted above; it must never re-mint.
      //
      // What a caller gives up by omitting `deriveEmptinessFor`: `empty` falls back to the
      // provisional `size === 0` reading, which can read `true` for a repo that already has
      // content (GitHub's `size` lags upward). That is the PRE-row-65 answer, and it is
      // only safe because the one place a false `empty: true` does damage — wireframe 13a,
      // where `empty` lifts the row's `data-disabled` gate — asks with `filter=empty` and
      // therefore always gets the probed verdict. `GithubConnectionService.listRepos` is
      // where that mapping from query to intent lives.
      //
      // Fenced from both sides, because the failure mode is silent: the api e2e
      // asserts a fresh `auto_init` fixture appears under `filter=empty` AND stops
      // being empty after a second commit (tests/e2e/github-connection.e2e.ts), and
      // the nextjs render lane asserts the chosen row is not `data-disabled` before
      // clicking it. Do NOT relax either assertion — fix the derivation.
      const mapped = collected.map((r) => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        owner: r.owner.login,
        private: r.private,
        defaultBranch: r.default_branch,
        // Provisional: definitive for `size > 0`, and the fallback for a candidate
        // whose probe cannot answer.
        empty: r.size === 0,
      }));

      // `r.empty` here is still the provisional `size === 0` reading, so this filter IS
      // the `size > 0` short-circuit — the predicate can only narrow it further, never
      // resurrect a repo `size` already answered for.
      const candidates = deriveEmptinessFor
        ? mapped.filter((r) => r.empty && deriveEmptinessFor(r))
        : [];
      if (candidates.length > 0) {
        await mapWithConcurrency(
          candidates,
          EMPTINESS_PROBE_CONCURRENCY,
          async (repo) => {
            const probed = await probeRepoEmpty({
              apiBaseUrl,
              owner: repo.owner,
              repo: repo.name,
              headers,
              fetchImpl,
            });
            if (probed !== null) repo.empty = probed;
          },
        );
      }

      return mapped;
    },

    async getRepositoryFileContents({ installationId, owner, repo, path, ref }) {
      // ONE budget for the mint AND the read (DR3): `GET /v1/projects/:id/manifest` is
      // browser-facing too, and it makes two wrapped requests.
      const sleep = newRetryBudget();
      // Fresh token per read (the "mint-fresh-per-call, never store" invariant).
      const { token } = await mintInstallationToken({
        appId,
        privateKey,
        installationId,
        apiBaseUrl,
        fetchImpl,
        sleepImpl: sleep,
        maxAttempts,
      });
      const url = `${apiBaseUrl}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(
        ref,
      )}`;
      const res = await retrying(
        () =>
          fetchImpl(url, {
            method: "GET",
            headers: jsonHeaders(`token ${token}`),
          }),
        sleep,
      );
      // 404 ⇒ the repo, branch, or file does not exist — a distinct outcome the
      // caller maps to a not-found status (vs a corrupt-content 422). Not retryable,
      // so `withGithubRetry` surfaces it on the first attempt.
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new GithubAppRequestError(
          `GitHub contents read failed for ${owner}/${repo}/${path}@${ref}: ${res.status}`,
          { upstreamStatus: res.status },
        );
      }
      const raw = fileContentsSchema.parse(await res.json());
      // GitHub wraps the base64 payload with newlines; strip all whitespace before
      // decoding to the exact UTF-8 bytes.
      const content = Buffer.from(
        raw.content.replace(/\s/g, ""),
        "base64",
      ).toString("utf8");
      return { content, sha: raw.sha, path: raw.path };
    },
  };
}

/**
 * The client the **API process** builds (deferred review finding DR3).
 *
 * Plan row 64 gave every non-fallback request db-lib's shared backoff, with no
 * `maxAttempts` and no deadline — so each wrapped call could sleep `3 x 60 s`.
 * `listInstallationRepos` makes 1 wrapped mint + N wrapped page GETs (6 measured) and
 * `getRepositoryFileContents` makes 2, each retried INDEPENDENTLY, so a throttled
 * installation could hold `GET /v1/github/repos` — and the browser connection behind it
 * — open for over twenty minutes. **Before row 64 these routes failed fast.** D64.1's
 * analysis reasoned only about the DBOS step budget; the same primitive now sits on a
 * page-load path, and nothing in that decision considered it.
 *
 * The asymmetry is the fix, not a compromise. A DBOS git-ops step is durable, has no
 * human waiting, and a slow success genuinely beats a fast failure — so **db-lib's
 * defaults are left exactly as they are** and every workflow keeps the full 4-attempt /
 * 60 s-per-sleep budget. An interactive route is the opposite on all three counts, so it
 * gets {@link INTERACTIVE_GITHUB_MAX_ATTEMPTS} attempts and a
 * {@link INTERACTIVE_GITHUB_RETRY_BUDGET_MS} wall clock shared across the whole call.
 *
 * `src/server.ts` builds the API's one and only GitHub App client through here.
 */
export function makeInteractiveGithubAppClient(
  options: Omit<MakeGithubAppClientOptions, "maxAttempts" | "retryBudgetMs">,
): GithubAppClient {
  return makeGithubAppClient({
    ...options,
    maxAttempts: INTERACTIVE_GITHUB_MAX_ATTEMPTS,
    retryBudgetMs: INTERACTIVE_GITHUB_RETRY_BUDGET_MS,
  });
}

// `DEFAULT_GITHUB_MAX_ATTEMPTS` is re-exported so the interactive budget above and the
// workflow budget it deliberately undercuts can be compared in ONE place, by a test,
// rather than by a reader holding two repos in their head.
export { DEFAULT_GITHUB_MAX_ATTEMPTS };
