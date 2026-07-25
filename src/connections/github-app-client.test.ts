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

// ===========================================================================
// task-62 D9 — the RECLASSIFIED "fresh token per call" counters.
//
// These assertions used to live in `tests/e2e/github-connection.e2e.ts` (:170-173)
// and `tests/e2e/manifest.e2e.ts` (:194-198) as reads of the github-stub's
// `/__stub/calls` counter after a `/__stub/reset`. Real GitHub exposes no
// per-caller call counter, so there is NO real-host analogue: the assertion is
// about OUR client's internal call pattern, which is exactly a unit-level
// property. Reclassified here with an injected COUNTING fetchImpl at the client
// boundary — strictly more precise than the stub ever was, because it attributes
// each HTTP call to the method that made it instead of to a shared container.
//
// What the e2e keeps instead: a REAL pagination proof (the live account has 100+
// repos, so `parseNextLink` genuinely walks `Link: rel="next"`).
// ===========================================================================

function countingFetch(handler: (url: string) => Response) {
  const byRoute = new Map<string, number>();
  const bump = (key: string) => byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    bump(`${init?.method ?? "GET"} ${path}`);
    return handler(url);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    count: (key: string) => byRoute.get(key) ?? 0,
    total: () => [...byRoute.values()].reduce((a, b) => a + b, 0),
  };
}

const mintResponse = (token = "ghs_minted") =>
  new Response(
    JSON.stringify({
      token,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }),
    { status: 201 },
  );

describe("task-62 D9: fresh-installation-token-per-call (was a github-stub counter)", () => {
  it("two listInstallationRepos calls ⇒ exactly TWO mints and TWO listing GETs", async () => {
    const { fetchImpl, count, total } = countingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(JSON.stringify({ total_count: 0, repositories: [] }), {
            status: 200,
          }),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    await client.listInstallationRepos({ installationId: "77" });
    await client.listInstallationRepos({ installationId: "77" });

    // No caching across calls: one exchange per listing, never reused.
    expect(count("POST /app/installations/77/access_tokens")).toBe(2);
    expect(count("GET /installation/repositories")).toBe(2);
    // And nothing else was called.
    expect(total()).toBe(4);
  });

  it("one getRepositoryFileContents ⇒ exactly ONE mint and ONE contents GET", async () => {
    const { fetchImpl, count, total } = countingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(
            JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from("{}", "utf8").toString("base64"),
              sha: "deadbeef",
              path: "supagloo.project.json",
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

    await client.getRepositoryFileContents({
      installationId: "77",
      owner: "octo",
      repo: "widget",
      path: "supagloo.project.json",
      ref: "v0.0.1",
    });

    expect(count("POST /app/installations/77/access_tokens")).toBe(1);
    expect(count("GET /repos/octo/widget/contents/supagloo.project.json")).toBe(1);
    expect(total()).toBe(2);
  });

  it("a multi-segment contents path is not collapsed (real Contents API accepts it)", async () => {
    // The retired github-stub only ever routed a SINGLE path segment, so nested
    // manifest paths were untested. Real GitHub accepts arbitrary depth.
    const { fetchImpl, count } = countingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(
            JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from("{}", "utf8").toString("base64"),
              sha: "s",
              path: "cfg/nested/supagloo.project.json",
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
    const file = await client.getRepositoryFileContents({
      installationId: "77",
      owner: "octo",
      repo: "widget",
      path: "cfg/nested/supagloo.project.json",
      ref: "main",
    });
    expect(file?.path).toBe("cfg/nested/supagloo.project.json");
    expect(
      count("GET /repos/octo/widget/contents/cfg/nested/supagloo.project.json"),
    ).toBe(1);
  });
});

// ===========================================================================
// task-62 §11.6 — failure injection that the github-stub used to FAKE, now at
// unit level with an injected fetch (design-delta §10.6: never real e2e egress).
// Each case is a shape real api.github.com actually returns.
// ===========================================================================

describe("task-62 §11.6: real-GitHub failure shapes (injected fetch, zero egress)", () => {
  const client = (fetchImpl: typeof fetch, privateKey = PRIVATE_KEY) =>
    makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey,
      fetchImpl,
    });

  it("401 'A JWT could not be decoded' surfaces the status (bad appId/PEM pairing)", async () => {
    // Row 62 item (c)'s bug class: a PEM whose newlines were mangled, or an
    // appId that does not belong to the key, yields a signed-but-rejected JWT.
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ message: "A JWT could not be decoded" }),
          { status: 401 },
        ),
    );
    await expect(client(fetchImpl).verifyInstallation("77")).rejects.toThrow(
      /401/,
    );
  });

  it("a PEM that is not a usable private key throws at SIGN time, before any network call", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response("{}", { status: 200 }),
    );
    await expect(
      client(fetchImpl, "-----BEGIN RSA PRIVATE KEY-----\nnot-base64\n-----END RSA PRIVATE KEY-----")
        .verifyInstallation("77"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("404 on the token exchange (unknown/removed installation) fails the listing", async () => {
    // Row 62 item (d)'s bug class exactly: the fabricated installation `42` 404s
    // against real GitHub. The failure must be attributable to the exchange.
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    await expect(
      client(fetchImpl).listInstallationRepos({ installationId: "999999" }),
    ).rejects.toThrow(/installation token exchange failed for installation 999999/);
    // It never proceeded to the listing call.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/app/installations/999999/access_tokens");
  });

  it("403 + Retry-After is NOT retried by the client today (deferred: task-62 D19-N2)", async () => {
    // Deliberate, recorded scope boundary. Rate-limit backoff lives in the e2e
    // HARNESS (task-62 D7); pushing it into the product client would touch three
    // repos including db-lib. The contract asserted here is the CURRENT one: one
    // attempt, then a throw that names the status. If a future task adds retry,
    // this test is the one that must be updated deliberately.
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
          { status: 403, headers: { "retry-after": "60" } },
        ),
    );
    await expect(
      client(fetchImpl).listInstallationRepos({ installationId: "77" }),
    ).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });

  it("429 on a mid-pagination page fails the whole listing rather than truncating it", async () => {
    // The dangerous failure mode is a SILENT partial listing: the user's repo
    // simply missing from the picker. A rate-limited page must throw.
    let listingCalls = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      listingCalls += 1;
      if (listingCalls === 1) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            repositories: [
              {
                id: 1,
                name: "a",
                full_name: "octo/a",
                owner: { login: "octo" },
                private: true,
                default_branch: "main",
                size: 0,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
            },
          },
        );
      }
      return new Response(JSON.stringify({ message: "rate limited" }), {
        status: 429,
        headers: { "x-ratelimit-remaining": "0" },
      });
    });
    await expect(
      client(fetchImpl).listInstallationRepos({ installationId: "77" }),
    ).rejects.toThrow(/429/);
    expect(listingCalls).toBe(2);
  });

  it("422 from the contents read is a throw, distinct from the 404 → null outcome", async () => {
    const { fetchImpl } = recordingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(
            JSON.stringify({ message: "Unprocessable Entity" }),
            { status: 422 },
          ),
    );
    await expect(
      client(fetchImpl).getRepositoryFileContents({
        installationId: "77",
        owner: "octo",
        repo: "widget",
        path: "supagloo.project.json",
        ref: "main",
      }),
    ).rejects.toThrow(/422/);
  });

  it("a DIRECTORY response (path points at a dir) fails the parse rather than decoding garbage", async () => {
    // Real GitHub returns a JSON ARRAY for a directory. `fileContentsSchema`
    // requires `type:"file"`, so this must not silently produce empty content.
    const { fetchImpl } = recordingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(JSON.stringify([{ type: "file", name: "a.json" }]), {
            status: 200,
          }),
    );
    await expect(
      client(fetchImpl).getRepositoryFileContents({
        installationId: "77",
        owner: "octo",
        repo: "widget",
        path: "cfg",
        ref: "main",
      }),
    ).rejects.toThrow();
  });

  it("encoding:'none' (>1MB file, Contents API representation switch) fails loudly", async () => {
    // Real GitHub switches to `encoding:"none"` + empty content above 1MB and
    // requires the blob API. Every Supagloo manifest is far under the cap, so the
    // right behaviour is a loud parse failure, never a silently-empty manifest.
    const { fetchImpl } = recordingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(
            JSON.stringify({
              type: "file",
              encoding: "none",
              content: "",
              sha: "big",
              path: "supagloo.project.json",
            }),
            { status: 200 },
          ),
    );
    await expect(
      client(fetchImpl).getRepositoryFileContents({
        installationId: "77",
        owner: "octo",
        repo: "widget",
        path: "supagloo.project.json",
        ref: "main",
      }),
    ).rejects.toThrow();
  });

  it("verifyInstallation tolerates an Organization account payload (login is what we store)", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 77,
            account: { login: "some-org", type: "Organization" },
            repository_selection: "all",
          }),
          { status: 200 },
        ),
    );
    expect(await client(fetchImpl).verifyInstallation("77")).toEqual({
      githubLogin: "some-org",
      repositorySelection: "all",
    });
  });
});
