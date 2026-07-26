import { z } from "zod";

/**
 * GitHub USER-authorization HTTP client for the create-new-repo JIT hop (Task #26,
 * design-delta §2.3/§6b). Mirrors `github-app-client.ts`: an injectable `fetch`,
 * closures over the app's OAuth config, unit-tested with hand-built `Response`
 * objects (no mocking library).
 *
 * Installation tokens cannot create a repo in a user's account, and an
 * out-of-band-created repo is not auto-added to a `selected`-mode installation. So
 * create-new-repo needs a one-time, ZERO-STORAGE user-token hop:
 *   - `buildAuthorizeUrl` → the hosted GitHub user-authorization URL (no network),
 *     built from the PUBLIC base — the user's own browser opens it.
 *   - `exchangeCode` → `POST {oauthInternalBase}/login/oauth/access_token` (code +
 *     the App's OAuth `client_id`/`client_secret`) → a short-lived `ghu_…` USER
 *     token. Server-to-server, hence the INTERNAL base (plan row 66).
 *   - `createUserRepo` → `POST {apiBase}/user/repos` with that user token → the repo.
 *   - `addRepoToInstallation` → `PUT {apiBase}/user/installations/:id/repositories/:repoId`
 *     with the same user token (only for `selected`-mode installations).
 * The user token is used ONLY inside a single `createRepoAndProject` call and is
 * never persisted anywhere.
 */

export interface CreatedUserRepo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}

export interface GithubUserAuthClient {
  /** The hosted GitHub user-authorization URL the wizard opens (no network). */
  buildAuthorizeUrl(args: { redirectUri: string; state: string }): string;
  /** Exchange a user-authorization `code` for a short-lived `ghu_…` user token. */
  exchangeCode(code: string): Promise<{ token: string }>;
  /** Create a repo in the user's account with the user token. */
  createUserRepo(args: {
    token: string;
    name: string;
    private: boolean;
  }): Promise<CreatedUserRepo>;
  /** Add a just-created repo to a `selected`-mode installation's access list. */
  addRepoToInstallation(args: {
    token: string;
    installationId: string;
    repositoryId: number;
  }): Promise<void>;
}

export interface MakeGithubUserAuthClientOptions {
  /**
   * The PUBLIC user-authorization OAuth host (`https://github.com`) — the one the
   * USER'S BROWSER opens. Used by `buildAuthorizeUrl` only.
   */
  oauthBaseUrl: string;
  /**
   * The INTERNAL user-authorization host, used by `exchangeCode` ONLY (plan row 66).
   *
   * `exchangeCode` is a SERVER-side POST from this process, while `buildAuthorizeUrl`
   * produces a URL the user's own machine must resolve. Sharing one value meant a
   * containerised api could not have its exchange redirected anywhere without also
   * moving the browser's redirect target — plan row 62 item (e)'s
   * DNS_PROBE_FINISHED_NXDOMAIN in one sentence.
   *
   * OPTIONAL, and defaults to `oauthBaseUrl`: unset ⇒ byte-identical behaviour to
   * before the split, which is what keeps "production needs zero config" true for
   * every already-deployed environment.
   */
  oauthInternalBaseUrl?: string;
  /** The REST API host (`https://api.github.com`). */
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * A typed failure of the user-authorization CODE→TOKEN exchange (task-62 D18-2).
 *
 * Real GitHub does NOT signal a rejected authorization code with a 4xx: `POST
 * /login/oauth/access_token` answers **HTTP 200** with a body like
 * `{"error":"bad_verification_code","error_description":…,"error_uri":…}`. The
 * retired github-stub accepted any non-empty code, so this shape never reached the
 * client and a 200-with-error fell through to `tokenResponseSchema.parse()`, which
 * threw an anonymous `ZodError: access_token Required` — mentioning neither GitHub
 * nor the actual cause. `code` carries GitHub's own machine-readable error string
 * so callers/logs can distinguish "the user's code expired" (retryable by
 * re-authorizing) from "our client_secret is wrong" (a deployment fault).
 */
export class GithubUserAuthExchangeError extends Error {
  /** GitHub's `error` field when present (e.g. `bad_verification_code`), else undefined. */
  readonly code?: string;
  /** GitHub's `error_description` when present. */
  readonly description?: string;
  readonly statusCode = 502;
  constructor(
    message: string,
    opts: { code?: string; description?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "GithubUserAuthExchangeError";
    this.code = opts.code;
    this.description = opts.description;
  }
}

/**
 * A typed failure of `POST /user/repos` (plan row 63 / D63.5).
 *
 * `createUserRepo` used to throw a bare `Error` with no `status`, and
 * `RepoProvisioningService.provisionRepo` re-wrapped every failure into the same
 * opaque `502 repo_creation_failed` — so a 422 "name already exists", a 401 bad token
 * and a 503 were indistinguishable to anyone reading the reply or the logs. The route's
 * status code and error slug are contract-pinned and do NOT change; what this adds is
 * the upstream `status` plus GitHub's own words, carried through the boundary so the
 * message can say WHICH upstream failure it was.
 */
export class GithubCreateRepoError extends Error {
  /** The upstream HTTP status from `POST /user/repos`. */
  readonly status: number;
  readonly statusCode = 502;
  constructor(message: string, opts: { status: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "GithubCreateRepoError";
    this.status = opts.status;
  }
}

/**
 * GitHub's error envelope, best-effort. `errors[].message` is where the useful text
 * lives on a 422 ("name already exists on this account"); `message` is the generic
 * top-level one ("Repository creation failed."). Never throws — a non-JSON body just
 * yields no detail rather than replacing the real failure with a parse error.
 */
async function readGithubErrorDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return "";
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return raw.trim().slice(0, 300);
  }
  const parsed = z
    .object({
      message: z.string().optional(),
      errors: z
        .array(z.object({ message: z.string().optional() }).passthrough())
        .optional(),
    })
    .safeParse(body);
  if (!parsed.success) return "";
  const detail = parsed.data.errors?.map((e) => e.message).filter(Boolean) ?? [];
  return [parsed.data.message, ...detail].filter(Boolean).join(" — ");
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
});

const createdRepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  default_branch: z.string(),
  clone_url: z.string(),
});

export function makeGithubUserAuthClient(
  options: MakeGithubUserAuthClientOptions,
): GithubUserAuthClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const oauthBaseUrl = options.oauthBaseUrl.replace(/\/+$/, "");
  // Plan row 66: normalised SEPARATELY from the public one, and defaulted to it.
  const oauthInternalBaseUrl = (
    options.oauthInternalBaseUrl ?? options.oauthBaseUrl
  ).replace(/\/+$/, "");
  const apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  const { clientId, clientSecret } = options;

  return {
    buildAuthorizeUrl({ redirectUri, state }) {
      const url = new URL(`${oauthBaseUrl}/login/oauth/authorize`);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "repo");
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode(code) {
      // The INTERNAL host (plan row 66) — this is a server-to-server POST, not
      // anything the browser ever sees. `buildAuthorizeUrl` above keeps the public one.
      const res = await fetchImpl(`${oauthInternalBaseUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
        }),
      });
      if (!res.ok) {
        throw new GithubUserAuthExchangeError(
          `GitHub user-auth code exchange failed with HTTP ${res.status}`,
        );
      }

      // task-62 D18-2: real GitHub answers a REJECTED code with HTTP 200 and an
      // `error` field, so a 200 is not yet success. Parse defensively (a non-JSON
      // 200 means something upstream ignored our `accept: application/json`), then
      // check for `error` BEFORE the token schema so the typed failure carries
      // GitHub's own code instead of an anonymous "access_token Required".
      let body: unknown;
      try {
        body = await res.json();
      } catch (cause) {
        throw new GithubUserAuthExchangeError(
          `GitHub user-auth code exchange returned a non-JSON 200 body ` +
            `(expected application/json; got ` +
            `${res.headers.get("content-type") ?? "no content-type"})`,
          { cause },
        );
      }

      const errorEnvelope = z
        .object({
          error: z.string().min(1),
          error_description: z.string().optional(),
          error_uri: z.string().optional(),
        })
        .safeParse(body);
      if (errorEnvelope.success) {
        const { error, error_description, error_uri } = errorEnvelope.data;
        throw new GithubUserAuthExchangeError(
          `GitHub rejected the user-authorization code exchange: ${error}` +
            (error_description ? ` — ${error_description}` : "") +
            (error_uri ? ` (${error_uri})` : ""),
          { code: error, description: error_description },
        );
      }

      const parsed = tokenResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new GithubUserAuthExchangeError(
          `GitHub user-auth code exchange returned no access_token and no error ` +
            `field — the response shape is not GitHub's documented envelope`,
          { cause: parsed.error },
        );
      }
      return { token: parsed.data.access_token };
    },

    async createUserRepo({ token, name, private: priv }) {
      const res = await fetchImpl(`${apiBaseUrl}/user/repos`, {
        method: "POST",
        headers: {
          authorization: `token ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        // `auto_init: true` (plan row 63). Without it the created repo has ZERO commits
        // and no `main` ref, so `scaffoldProjectWorkflow`'s `openPullRequest(base:
        // "main")` 422s — the product's headline designed path could not scaffold at
        // all. It is a field on this SAME single `POST /user/repos` the zero-storage
        // user token is minted for (design-delta §2.3:181-192), so it costs no extra
        // scope, no extra request and no extra credential exposure; and it keeps
        // wireframe 12a step 2's designed row 5 ("Pushed → opened & merged PR into
        // main") literally true. `private` stays CALLER-CONTROLLED — 12a step 1 designs
        // a `🔒 Private ▾` toggle, so it must never be hardcoded.
        //
        // This is only half the fix: the existing-empty-repo path (wireframe 13a) has
        // no create call to send it on, so `scaffoldProjectWorkflow` bootstraps an
        // unborn base ref itself (`scaffold-project/workspace.ts` `ensureBaseRef`).
        body: JSON.stringify({ name, private: priv, auto_init: true }),
      });
      if (!res.ok) {
        const detail = await readGithubErrorDetail(res);
        throw new GithubCreateRepoError(
          `GitHub create-repo failed for ${name}: ${res.status}` +
            (detail ? ` — ${detail}` : ""),
          { status: res.status },
        );
      }
      const raw = createdRepoSchema.parse(await res.json());
      return {
        id: raw.id,
        name: raw.name,
        fullName: raw.full_name,
        owner: raw.owner.login,
        private: raw.private,
        defaultBranch: raw.default_branch,
        cloneUrl: raw.clone_url,
      };
    },

    async addRepoToInstallation({ token, installationId, repositoryId }) {
      const res = await fetchImpl(
        `${apiBaseUrl}/user/installations/${installationId}/repositories/${repositoryId}`,
        {
          method: "PUT",
          headers: {
            authorization: `token ${token}`,
            accept: "application/vnd.github+json",
          },
        },
      );
      if (!res.ok) {
        throw new Error(
          `GitHub add-repo-to-installation failed for ${installationId}/${repositoryId}: ${res.status}`,
        );
      }
      // 204 No Content — nothing to parse.
    },
  };
}
