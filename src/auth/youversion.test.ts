import { describe, it, expect } from "vitest";
import { makeYouVersionVerifier } from "./youversion";

// The YouVersion access-token verifier (contract: scratch/auth-and-sessions.md §0).
// Unit-tested with an INJECTED fetch (fake) — no network. The real stub over real
// HTTP is exercised by tests/e2e/auth.e2e.ts (no mocking there).
function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response,
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
}

const USERINFO = {
  id: "yv-user-1001",
  first_name: "Ada",
  last_name: "Lovelace",
  email: "ada@example.test",
  avatar_url: "https://cdn.example.test/avatars/ada.png",
};

describe("makeYouVersionVerifier", () => {
  it("calls GET {base}/auth/v1/userinfo with the forwarded bearer token", async () => {
    let seenUrl = "";
    let seenAuth: string | undefined;
    const verify = makeYouVersionVerifier({
      baseUrl: "http://youversion-stub:8080",
      fetchImpl: fakeFetch((url, init) => {
        seenUrl = url;
        const headers = new Headers(init?.headers);
        seenAuth = headers.get("authorization") ?? undefined;
        return new Response(JSON.stringify(USERINFO), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });

    await verify("access-abc");

    expect(seenUrl).toBe("http://youversion-stub:8080/auth/v1/userinfo");
    expect(seenAuth).toBe("Bearer access-abc");
  });

  it("maps userinfo onto the User shape (id, displayName, email, initials)", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(
        () => new Response(JSON.stringify(USERINFO), { status: 200 }),
      ),
    });

    const info = await verify("access-abc");

    expect(info).toEqual({
      youversionUserId: "yv-user-1001",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      avatarInitials: "AL",
    });
  });

  it("returns null on a 401 (invalid/expired access token)", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(
        () =>
          new Response(JSON.stringify({ error: "invalid_token" }), {
            status: 401,
          }),
      ),
    });
    expect(await verify("bad")).toBeNull();
  });

  it("throws on an unexpected upstream error (5xx)", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(() => new Response("boom", { status: 500 })),
    });
    await expect(verify("x")).rejects.toThrow();
  });
});
