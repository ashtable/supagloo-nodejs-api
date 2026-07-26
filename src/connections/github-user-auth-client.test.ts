import { describe, it, expect } from "vitest";
import {
  makeGithubUserAuthClient,
  GithubUserAuthExchangeError,
} from "./github-user-auth-client";

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

  // ------------------------------------------------------------------ task-62 D18-2
  // REAL GitHub does NOT use a 4xx for a rejected authorization code: it answers
  // HTTP **200** with `{"error":"bad_verification_code", ...}` (documented behaviour
  // of `POST /login/oauth/access_token`). The github-stub accepted ANY non-empty code,
  // so this path never ran in the old e2e; against real github.com it is the single
  // most likely response while developing the create-new-repo hop. Before the fix the
  // 200 fell through to `tokenResponseSchema.parse`, which threw an opaque
  // `ZodError: access_token Required` with no mention of GitHub, the code, or the
  // remediation. It must be a TYPED failure carrying GitHub's own error code.
  it("HTTP 200 with { error: 'bad_verification_code' } becomes a TYPED exchange failure", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "bad_verification_code",
            error_description:
              "The code passed is incorrect or expired.",
            error_uri:
              "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#bad-verification-code",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const err = await makeClient(fetchImpl)
      .exchangeCode("already-used-code")
      .then(
        () => {
          throw new Error("expected exchangeCode to reject");
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(GithubUserAuthExchangeError);
    const typed = err as GithubUserAuthExchangeError;
    expect(typed.code).toBe("bad_verification_code");
    expect(typed.description).toBe("The code passed is incorrect or expired.");
    // The message must name GitHub's error code so a red e2e is diagnosable from
    // one log line (never an anonymous Zod "Required").
    expect(typed.message).toContain("bad_verification_code");
    expect(typed.message).not.toMatch(/access_token/);
  });

  it("carries the error code for the other documented 200-with-error variants", async () => {
    for (const code of [
      "incorrect_client_credentials",
      "redirect_uri_mismatch",
      "unverified_user_email",
    ]) {
      const { fetchImpl } = recordingFetch(
        () => new Response(JSON.stringify({ error: code }), { status: 200 }),
      );
      const err = await makeClient(fetchImpl)
        .exchangeCode("c")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GithubUserAuthExchangeError);
      expect((err as GithubUserAuthExchangeError).code).toBe(code);
    }
  });

  it("throws when a 200 response omits BOTH access_token and error", async () => {
    // Not GitHub's documented shape at all (a proxy/HTML interstitial, say). This
    // must still fail loudly — as a typed exchange failure, not a raw Zod error —
    // and say that no access_token was returned.
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 }),
    );
    const err = await makeClient(fetchImpl)
      .exchangeCode("c")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubUserAuthExchangeError);
    expect((err as GithubUserAuthExchangeError).message).toMatch(
      /no access_token/i,
    );
  });

  it("a 5xx from the OAuth host is a typed failure naming the status", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response("<html>unicorn</html>", { status: 502 }),
    );
    const err = await makeClient(fetchImpl)
      .exchangeCode("c")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubUserAuthExchangeError);
    expect((err as GithubUserAuthExchangeError).message).toContain("502");
  });

  it("a non-JSON 200 body is a typed failure, not a SyntaxError", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response("access_token=ghu_x&scope=repo&token_type=bearer", {
          status: 200,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
    );
    // We always send `accept: application/json`, so a form-encoded body means
    // something upstream ignored it — surface that as our own typed failure.
    const err = await makeClient(fetchImpl)
      .exchangeCode("c")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubUserAuthExchangeError);
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
            clone_url: "https://github.com/octo-test/psalm-121.git",
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

  // ------------------------------------------------------------------ task-62 D13
  // The live `ashtable` installation is `repository_selection: "all"` (preflight §1),
  // so `RepoProvisioningService` correctly SKIPS this call (repo-provisioning-service
  // .ts:96) and the api e2e can never exercise it against real GitHub. Real GitHub
  // 422s a `PUT /user/installations/:id/repositories/:repoId` against an all-repos
  // installation ("Repository access list is not editable"). That reality lives HERE,
  // at unit level, with an injected fetch — never as e2e egress (design-delta §10.6).
  it("surfaces real GitHub's 422 for an all-repos installation (the branch e2e cannot reach)", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            message: "Repository access list is not editable",
            documentation_url:
              "https://docs.github.com/rest/apps/installations",
          }),
          { status: 422 },
        ),
    );
    await expect(
      makeClient(fetchImpl).addRepoToInstallation({
        token: "ghu_user_1",
        installationId: "9000001",
        repositoryId: 7,
      }),
    ).rejects.toThrow(/422/);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
  });
});
