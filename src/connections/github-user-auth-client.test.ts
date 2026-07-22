import { describe, it, expect } from "vitest";
import { makeGithubUserAuthClient } from "./github-user-auth-client";

// The GitHub USER-authorization client for the create-new-repo JIT hop (Task #26,
// design-delta §2.3/§6b). Mirrors github-app-client.ts: injectable fetch, unit-tested
// with hand-built Response objects. Unlike the App client (App JWT + installation
// tokens), this does the one-time user-token dance:
//   - buildAuthorizeUrl → the hosted GitHub user-authorization URL (no network).
//   - exchangeCode → POST {oauthBase}/login/oauth/access_token → a ghu_ user token.
//   - createUserRepo → POST {apiBase}/user/repos with the ghu_ token → created repo.
//   - addRepoToInstallation → PUT {apiBase}/user/installations/:id/repositories/:repo.

const CLIENT_ID = "Iv1.stubclient";
const CLIENT_SECRET = "stubsecret";

function recordingFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
) {
  const calls: {
    url: string;
    auth?: string;
    method?: string;
    body?: string;
  }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      auth: headers.get("authorization") ?? undefined,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(fetchImpl?: typeof fetch) {
  return makeGithubUserAuthClient({
    oauthBaseUrl: "https://github.com",
    apiBaseUrl: "https://api.github.com",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl,
  });
}

describe("makeGithubUserAuthClient.buildAuthorizeUrl", () => {
  it("composes the user-authorization URL from client_id, redirect_uri, scope, state", () => {
    const url = makeClient().buildAuthorizeUrl({
      redirectUri: "https://app.example/connect/github/create-repo/callback",
      state: "nonce-1",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://app.example/connect/github/create-repo/callback",
    );
    expect(parsed.searchParams.get("scope")).toBe("repo");
    expect(parsed.searchParams.get("state")).toBe("nonce-1");
  });
});

describe("makeGithubUserAuthClient.exchangeCode", () => {
  it("POSTs the code + client creds to /login/oauth/access_token and returns the ghu_ token", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "ghu_stub_user_1",
            token_type: "bearer",
            scope: "repo",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await makeClient(fetchImpl).exchangeCode("the-code");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://github.com/login/oauth/access_token");
    const sent = JSON.parse(calls[0].body!);
    expect(sent).toMatchObject({
      code: "the-code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(result.token).toBe("ghu_stub_user_1");
  });

  it("throws on a non-2xx exchange", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 400 }),
    );
    await expect(makeClient(fetchImpl).exchangeCode("nope")).rejects.toThrow();
  });

  it("throws when the response omits access_token", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ error: "x" }), { status: 200 }),
    );
    await expect(makeClient(fetchImpl).exchangeCode("c")).rejects.toThrow();
  });
});

describe("makeGithubUserAuthClient.createUserRepo", () => {
  it("POSTs /user/repos with the ghu_ token and { name, private }, maps the created repo", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 7,
            name: "psalm-121",
            full_name: "acme/psalm-121",
            private: true,
            owner: { login: "acme" },
            default_branch: "main",
            clone_url: "http://git-server:8080/acme/psalm-121.git",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    const repo = await makeClient(fetchImpl).createUserRepo({
      token: "ghu_stub_user_1",
      name: "psalm-121",
      private: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.github.com/user/repos");
    expect(calls[0].auth).toBe("token ghu_stub_user_1");
    expect(JSON.parse(calls[0].body!)).toMatchObject({
      name: "psalm-121",
      private: true,
    });
    expect(repo).toMatchObject({
      id: 7,
      name: "psalm-121",
      owner: "acme",
      defaultBranch: "main",
    });
  });

  it("throws on a non-2xx repo creation", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ message: "Requires authentication" }), { status: 401 }),
    );
    await expect(
      makeClient(fetchImpl).createUserRepo({ token: "ghs_wrong", name: "x", private: false }),
    ).rejects.toThrow();
  });
});

describe("makeGithubUserAuthClient.addRepoToInstallation", () => {
  it("PUTs /user/installations/:id/repositories/:repoId with the ghu_ token, resolves on 204", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    await makeClient(fetchImpl).addRepoToInstallation({
      token: "ghu_stub_user_1",
      installationId: "42",
      repositoryId: 7,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe(
      "https://api.github.com/user/installations/42/repositories/7",
    );
    expect(calls[0].auth).toBe("token ghu_stub_user_1");
  });

  it("throws on a non-2xx installation-add", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status: 401 }));
    await expect(
      makeClient(fetchImpl).addRepoToInstallation({
        token: "ghs_wrong",
        installationId: "42",
        repositoryId: 7,
      }),
    ).rejects.toThrow();
  });
});
