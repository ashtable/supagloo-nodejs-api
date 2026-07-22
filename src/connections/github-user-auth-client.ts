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
 *   - `buildAuthorizeUrl` → the hosted GitHub user-authorization URL (no network).
 *   - `exchangeCode` → `POST {oauthBase}/login/oauth/access_token` (code + the App's
 *     OAuth `client_id`/`client_secret`) → a short-lived `ghu_…` USER token.
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
  /** The user-authorization OAuth host (`https://github.com`). */
  oauthBaseUrl: string;
  /** The REST API host (`https://api.github.com`). */
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
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
      const res = await fetchImpl(`${oauthBaseUrl}/login/oauth/access_token`, {
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
        throw new Error(`GitHub user-auth code exchange failed: ${res.status}`);
      }
      const raw = tokenResponseSchema.parse(await res.json());
      return { token: raw.access_token };
    },

    async createUserRepo({ token, name, private: priv }) {
      const res = await fetchImpl(`${apiBaseUrl}/user/repos`, {
        method: "POST",
        headers: {
          authorization: `token ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name, private: priv }),
      });
      if (!res.ok) {
        throw new Error(`GitHub create-repo failed for ${name}: ${res.status}`);
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
