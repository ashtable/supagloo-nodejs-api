import { z } from "zod";
import {
  signAppJwt,
  mintInstallationToken,
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
  // GitHub reports `size` in KILOBYTES and computes it ASYNCHRONOUSLY, so a
  // just-created repo — including one with a single small README commit from
  // `auto_init: true` — reports 0. That is what makes `empty = size === 0` work for
  // wireframe 13a's "Empty · created just now" badge. See the derivation note below.
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

  const jsonHeaders = (auth: string) => ({
    authorization: auth,
    accept: "application/vnd.github+json",
  });

  return {
    async verifyInstallation(installationId) {
      const jwt = signAppJwt({ appId, privateKey });
      const res = await fetchImpl(
        `${apiBaseUrl}/app/installations/${installationId}`,
        { method: "GET", headers: jsonHeaders(`Bearer ${jwt}`) },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(
          `GitHub installation verify failed for ${installationId}: ${res.status}`,
        );
      }
      const raw = installationSchema.parse(await res.json());
      return {
        githubLogin: raw.account.login,
        repositorySelection: raw.repository_selection,
      };
    },

    async listInstallationRepos({ installationId }) {
      // Mint ONCE per listing (the "fresh-token-per-call, never store" invariant
      // is per `listInstallationRepos` call) and reuse it across every page.
      const { token } = await mintInstallationToken({
        appId,
        privateKey,
        installationId,
        apiBaseUrl,
        fetchImpl,
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
        const res = await fetchImpl(nextUrl, { method: "GET", headers });
        if (!res.ok) {
          throw new Error(
            `GitHub installation repos list failed for ${installationId}: ${res.status}`,
          );
        }
        const raw = reposResponseSchema.parse(await res.json());
        collected.push(...raw.repositories);
        nextUrl = parseNextLink(res.headers.get("link"));
      }

      // EMPTINESS DERIVATION — reviewed and deliberately UNCHANGED in task-62 (D16).
      //
      // `size` is KB-rounded and computed asynchronously by GitHub, so it lags UPWARD:
      // it can read 0 for a repo that already has content, but it never overstates. The
      // risk is therefore a false `empty: true`, whose blast radius is the repo picker
      // offering an already-populated repo as a scaffold target.
      //
      // A live read-only probe (2026-07-25) found small real repos genuinely reporting
      // `size: 0`, so an `auto_init` fixture (one README commit) does list as empty —
      // i.e. REALITY DOES NOT DIFFER for the shapes this product creates, and
      // design-delta §10.4a's rule ("if reality differs, the client changes, not the
      // tests") does not fire. Changing it here would be unforced risk.
      //
      // The failure mode is silent (a `data-disabled` picker row whose click is a
      // no-op), so it is fenced from BOTH sides instead: the api e2e asserts this
      // run's fixture repo appears under `filter=empty`
      // (tests/e2e/github-connection.e2e.ts), and the nextjs render lane asserts the
      // chosen row is not `data-disabled` before clicking it.
      //
      // CONTINGENCY, if that ever goes red — plan row N3, deliberately NOT done
      // pre-emptively: treat `size > 0` as definitive not-empty, and probe
      // `GET /repos/:o/:r/commits?per_page=2` for the `size === 0` subset only
      // (409 "Git Repository is empty" ⇒ empty; 200 with ≤1 commit ⇒ empty; ≥2 ⇒ not
      // empty), concurrency-capped. Do NOT relax the e2e assertion instead.
      return collected.map((r) => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        owner: r.owner.login,
        private: r.private,
        defaultBranch: r.default_branch,
        empty: r.size === 0,
      }));
    },

    async getRepositoryFileContents({ installationId, owner, repo, path, ref }) {
      // Fresh token per read (the "mint-fresh-per-call, never store" invariant).
      const { token } = await mintInstallationToken({
        appId,
        privateKey,
        installationId,
        apiBaseUrl,
        fetchImpl,
      });
      const url = `${apiBaseUrl}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(
        ref,
      )}`;
      const res = await fetchImpl(url, {
        method: "GET",
        headers: jsonHeaders(`token ${token}`),
      });
      // 404 ⇒ the repo, branch, or file does not exist — a distinct outcome the
      // caller maps to a not-found status (vs a corrupt-content 422).
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(
          `GitHub contents read failed for ${owner}/${repo}/${path}@${ref}: ${res.status}`,
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
