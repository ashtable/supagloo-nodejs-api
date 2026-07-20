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

    // The listing now requests GitHub's max page size (per_page=100); with no
    // `Link: rel="next"` on this single-page response the client stops here.
    expect(calls[1].url).toBe(
      "https://api.github.com/installation/repositories?per_page=100",
    );
    expect(calls[1].auth).toContain("ghs_minted_1");
    expect(calls).toHaveLength(2);

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

  it("follows Link rel=\"next\" pagination and returns the union of every page", async () => {
    // GET /installation/repositories is paginated (default 30, max 100 per_page).
    // A single unpaginated fetch silently truncates any installation with more
    // repos than one page — a user's target repo vanishing from the picker. The
    // client must request per_page=100 and follow `Link: rel="next"` to exhaustion.
    const repo = (id: number, name: string, size: number, priv: boolean) => ({
      id,
      name,
      full_name: `acme/${name}`,
      owner: { login: "acme" },
      private: priv,
      default_branch: "main",
      size,
    });

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
      const page = new URL(url).searchParams.get("page") ?? "1";
      if (page === "1") {
        // A full first page + a `rel="next"` link to page 2 (and a `rel="last"`,
        // which the client must ignore in favour of following `next`).
        return new Response(
          JSON.stringify({
            total_count: 3,
            repositories: [
              repo(101, "empty-one", 0, true),
              repo(102, "empty-two", 0, false),
            ],
          }),
          {
            status: 200,
            headers: {
              link:
                '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next", ' +
                '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="last"',
            },
          },
        );
      }
      // Last page: no `rel="next"` ⇒ the loop terminates here.
      return new Response(
        JSON.stringify({
          total_count: 3,
          repositories: [repo(103, "psalms-video", 512, false)],
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

    // The UNION of both pages, in order — not just the first page.
    expect(repos.map((r) => r.id)).toEqual([101, 102, 103]);

    // The client actually issued multiple HTTP requests (didn't trust one page).
    const repoCalls = calls.filter((c) =>
      c.url.includes("/installation/repositories"),
    );
    expect(repoCalls).toHaveLength(2);
    // It asked for the max page size on the first request.
    expect(repoCalls[0].url).toContain("per_page=100");
    // Exactly ONE token minted for the whole listing, reused across pages.
    const mintCalls = calls.filter((c) => c.url.endsWith("/access_tokens"));
    expect(mintCalls).toHaveLength(1);
    for (const c of repoCalls) expect(c.auth).toContain("ghs_minted_1");
  });
});

describe("makeGithubAppClient.getRepositoryFileContents", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("mints an installation token then reads the contents API with it, decoding base64→utf8", async () => {
    const raw = JSON.stringify({ manifestVersion: 1, hello: "world" });
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_minted_1",
            expires_at: "2026-07-19T13:00:00.000Z",
          }),
          { status: 201 },
        );
      }
      return new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          // GitHub wraps base64 content with newlines — the client must tolerate it.
          content: b64(raw).replace(/(.{4})/g, "$1\n"),
          sha: "abc123",
          path: "supagloo.project.json",
          name: "supagloo.project.json",
          size: raw.length,
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

    const file = await client.getRepositoryFileContents({
      installationId: "42",
      owner: "acme",
      repo: "psalms-video",
      path: "supagloo.project.json",
      ref: "v0.0.1",
    });

    // First mint (App JWT), then read (minted installation token).
    expect(calls[0].url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(calls[0].auth?.startsWith("Bearer ")).toBe(true);
    expect(isJwt(calls[0].auth!.slice("Bearer ".length))).toBe(true);

    expect(calls[1].url).toBe(
      "https://api.github.com/repos/acme/psalms-video/contents/supagloo.project.json?ref=v0.0.1",
    );
    expect(calls[1].auth).toContain("ghs_minted_1");
    expect(calls).toHaveLength(2);

    // Content is decoded to the exact UTF-8 bytes (whitespace in the base64 ignored).
    expect(file).toEqual({
      content: raw,
      sha: "abc123",
      path: "supagloo.project.json",
    });
  });

  it("returns null when the contents API 404s (missing file/branch/repo)", async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_x", expires_at: "2026-07-19T13:00:00.000Z" }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      });
    });
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    expect(
      await client.getRepositoryFileContents({
        installationId: "42",
        owner: "acme",
        repo: "psalms-video",
        path: "supagloo.project.json",
        ref: "v0.0.9",
      }),
    ).toBeNull();
  });

  it("throws on an unexpected upstream error (5xx)", async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_x", expires_at: "2026-07-19T13:00:00.000Z" }),
          { status: 201 },
        );
      }
      return new Response("boom", { status: 500 });
    });
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    await expect(
      client.getRepositoryFileContents({
        installationId: "42",
        owner: "acme",
        repo: "psalms-video",
        path: "supagloo.project.json",
        ref: "v0.0.1",
      }),
    ).rejects.toThrow();
  });
});
