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

  // --- Edge cases of the documented (invented) userinfo contract (Task 34-E6). ---
  // NOTE: these pin the SHIPPED verifier's invented `GET /auth/v1/userinfo` contract
  // (fields id/first_name/last_name/email/avatar_url). The REAL YouVersion sign-in is
  // JWT-claims-based (no userinfo GET); rewriting the verifier to match is a scoped
  // follow-up (see the 34-E6 report). Until then, these characterize what ships.

  it("stringifies a NUMERIC id (the union+transform branch) → youversionUserId", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({ ...USERINFO, id: 1234567 }),
            { status: 200 },
          ),
      ),
    });
    const info = await verify("access-abc");
    expect(info?.youversionUserId).toBe("1234567");
  });

  it("with NO first/last name → displayName falls back to email, initials from email", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({ id: "yv-2", email: "grace@hopper.test" }),
            { status: 200 },
          ),
      ),
    });
    const info = await verify("access-abc");
    expect(info?.displayName).toBe("grace@hopper.test");
    // initialsFrom's fallback: first two alphanumerics of the display name, upper.
    expect(info?.avatarInitials).toBe("GR");
  });

  it("with only a first name → displayName is that name, a single initial", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              id: "yv-3",
              first_name: "Madonna",
              email: "m@example.test",
            }),
            { status: 200 },
          ),
      ),
    });
    const info = await verify("access-abc");
    expect(info?.displayName).toBe("Madonna");
    expect(info?.avatarInitials).toBe("M");
  });

  it("normalizes a trailing slash in baseUrl (no double slash in the request URL)", async () => {
    let seenUrl = "";
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv/",
      fetchImpl: fakeFetch((url) => {
        seenUrl = url;
        return new Response(JSON.stringify(USERINFO), { status: 200 });
      }),
    });
    await verify("access-abc");
    expect(seenUrl).toBe("http://yv/auth/v1/userinfo");
  });

  it("throws on a malformed body missing the required email field", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(
        () =>
          new Response(JSON.stringify({ id: "yv-4", first_name: "No" }), {
            status: 200,
          }),
      ),
    });
    await expect(verify("access-abc")).rejects.toThrow();
  });

  it("throws when a 200 response body is not valid JSON", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(() => new Response("<<not json>>", { status: 200 })),
    });
    await expect(verify("access-abc")).rejects.toThrow();
  });

  it("throws on a non-401 client error (403) — only 401 maps to null", async () => {
    const verify = makeYouVersionVerifier({
      baseUrl: "http://yv",
      fetchImpl: fakeFetch(
        () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      ),
    });
    await expect(verify("access-abc")).rejects.toThrow();
  });
});
