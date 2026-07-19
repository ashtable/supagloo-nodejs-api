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
 */

export interface VerifiedInstallation {
  githubLogin: string;
  repositorySelection: string;
}

export interface GithubAppClient {
  verifyInstallation(installationId: string): Promise<VerifiedInstallation | null>;
  listInstallationRepos(args: {
    installationId: string;
  }): Promise<GithubRepo[]>;
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
  // A brand-new repo with no commits reports size 0 ⇒ we surface it as `empty`.
  size: z.number(),
});
const reposResponseSchema = z.object({
  repositories: z.array(repoSchema),
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

/** Restore a PEM whose newlines were escaped to the literal two-char `\n` (as
 *  env vars often carry multi-line secrets). A real multi-line PEM is unchanged. */
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
  };
}
