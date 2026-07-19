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
      const { token } = await mintInstallationToken({
        appId,
        privateKey,
        installationId,
        apiBaseUrl,
        fetchImpl,
      });
      const res = await fetchImpl(`${apiBaseUrl}/installation/repositories`, {
        method: "GET",
        headers: jsonHeaders(`token ${token}`),
      });
      if (!res.ok) {
        throw new Error(
          `GitHub installation repos list failed for ${installationId}: ${res.status}`,
        );
      }
      const raw = reposResponseSchema.parse(await res.json());
      return raw.repositories.map((r) => ({
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
