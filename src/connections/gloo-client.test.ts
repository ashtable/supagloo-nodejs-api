import { describe, it, expect } from "vitest";
import { makeGlooClient } from "./gloo-client";

// The Gloo HTTP client (design-delta §2.5/§8). Injectable fetch, unit-tested with
// hand-built Response objects. `verifyClientCredentials` mints a client-credentials
// test token: POST /oauth2/token with Basic base64(clientId:clientSecret) + form
// body grant_type=client_credentials. 2xx → true (verified), 4xx → false (bad
// credentials), 5xx/other → throws (unexpected upstream failure).

function recordingFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: {
    url: string;
    auth?: string;
    method?: string;
    body?: string;
    contentType?: string;
  }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    calls.push({
      url: String(input),
      auth: headers.get("authorization") ?? undefined,
      method: init?.method ?? "GET",
      body:
        rawBody instanceof URLSearchParams
          ? rawBody.toString()
          : typeof rawBody === "string"
            ? rawBody
            : undefined,
      contentType: headers.get("content-type") ?? undefined,
    });
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const decodeBasic = (auth?: string) =>
  auth?.startsWith("Basic ")
    ? Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8")
    : undefined;

describe("makeGlooClient.verifyClientCredentials", () => {
  it("POSTs a client-credentials mint with Basic auth + form body; 2xx → true", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "gloo_stub_1",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "api",
          }),
          { status: 200 },
        ),
    );
    const client = makeGlooClient({
      apiBaseUrl: "https://platform.ai.gloo.com",
      fetchImpl,
    });

    const ok = await client.verifyClientCredentials({
      clientId: "cid",
      clientSecret: "csecret",
    });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://platform.ai.gloo.com/oauth2/token");
    expect(decodeBasic(calls[0].auth)).toBe("cid:csecret");
    // Form-encoded client-credentials grant.
    expect(new URLSearchParams(calls[0].body).get("grant_type")).toBe(
      "client_credentials",
    );
    expect(calls[0].contentType).toContain("application/x-www-form-urlencoded");
  });

  it("returns false on a 401 invalid_client (bad credentials — expected)", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
    );
    const client = makeGlooClient({
      apiBaseUrl: "https://platform.ai.gloo.com",
      fetchImpl,
    });
    expect(
      await client.verifyClientCredentials({
        clientId: "bad",
        clientSecret: "bad",
      }),
    ).toBe(false);
  });

  it("throws on a 5xx (unexpected upstream failure, not a credential rejection)", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response("boom", { status: 503 }),
    );
    const client = makeGlooClient({
      apiBaseUrl: "https://platform.ai.gloo.com",
      fetchImpl,
    });
    await expect(
      client.verifyClientCredentials({ clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow();
  });
});
