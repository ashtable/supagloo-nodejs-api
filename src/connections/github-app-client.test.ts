import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { makeGithubAppClient } from "./github-app-client";

// The GitHub App HTTP client (design-delta §2.3/§6a). Mirrors youversion.ts:
// injectable fetch, unit-tested with hand-built Response objects (no mocking
// library). It wraps db-lib's signAppJwt + mintInstallationToken:
//   - verifyInstallation → GET /app/installations/:id with an APP JWT.
//   - listInstallationRepos → mint an installation token, then GET
//     /installation/repositories with THAT token (never cached/stored).

const { privateKey: PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP_ID = "123456";

function recordingFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
) {
  const calls: { url: string; auth?: string; method?: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      auth: headers.get("authorization") ?? undefined,
      method: init?.method ?? "GET",
    });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const isJwt = (tok: string) => tok.split(".").length === 3;

describe("makeGithubAppClient.verifyInstallation", () => {
  it("GETs /app/installations/:id with an App JWT and maps the result", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 42,
            account: { login: "acme" },
            repository_selection: "selected",
          }),
          { status: 200 },
        ),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    const result = await client.verifyInstallation("42");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/app/installations/42");
    expect(calls[0].auth?.startsWith("Bearer ")).toBe(true);
    expect(isJwt(calls[0].auth!.slice("Bearer ".length))).toBe(true);
    expect(result).toEqual({ githubLogin: "acme", repositorySelection: "selected" });
  });

  it("returns null on a 404 (installation not found)", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });
    expect(await client.verifyInstallation("999")).toBeNull();
  });

  it("throws on an unexpected upstream error (5xx)", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response("boom", { status: 500 }),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });
    await expect(client.verifyInstallation("42")).rejects.toThrow();
  });

  it("normalizes an escaped-newline PEM before signing", async () => {
    const escaped = PRIVATE_KEY.replace(/\n/g, "\\n");
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ id: 42, account: { login: "acme" }, repository_selection: "all" }),
          { status: 200 },
        ),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: escaped,
      fetchImpl,
    });
    // Must not throw: the escaped PEM is restored to a real key before signing.
    await client.verifyInstallation("42");
    expect(isJwt(calls[0].auth!.slice("Bearer ".length))).toBe(true);
  });
});

describe("makeGithubAppClient.listInstallationRepos", () => {
  it("mints an installation token then lists with it, mapping size→empty", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_minted_1",
            expires_at: "2026-07-18T13:00:00.000Z",
          }),
          { status: 201 },
        );
      }
      return new Response(
        JSON.stringify({
          total_count: 2,
          repositories: [
            {
              id: 101,
              name: "empty-one",
              full_name: "acme/empty-one",
              owner: { login: "acme" },
              private: true,
              default_branch: "main",
              size: 0,
            },
            {
              id: 103,
              name: "psalms-video",
              full_name: "acme/psalms-video",
              owner: { login: "acme" },
              private: false,
              default_branch: "main",
              size: 512,
            },
          ],
        }),
        { status: 200 },
      );
    });
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    const repos = await client.listInstallationRepos({ installationId: "42" });

    // First mint (App JWT), then list (minted installation token).
    expect(calls[0].url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(calls[0].auth?.startsWith("Bearer ")).toBe(true);
    expect(isJwt(calls[0].auth!.slice("Bearer ".length))).toBe(true);

    expect(calls[1].url).toBe("https://api.github.com/installation/repositories");
    expect(calls[1].auth).toContain("ghs_minted_1");

    expect(repos).toEqual([
      {
        id: 101,
        name: "empty-one",
        fullName: "acme/empty-one",
        owner: "acme",
        private: true,
        defaultBranch: "main",
        empty: true,
      },
      {
        id: 103,
        name: "psalms-video",
        fullName: "acme/psalms-video",
        owner: "acme",
        private: false,
        defaultBranch: "main",
        empty: false,
      },
    ]);
  });
});
