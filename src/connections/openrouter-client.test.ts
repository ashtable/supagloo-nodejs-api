import { describe, it, expect } from "vitest";
import { makeOpenRouterClient } from "./openrouter-client";

// The OpenRouter HTTP client (design-delta §2.5/§8). Mirrors github-app-client.ts:
// injectable fetch, unit-tested with hand-built Response objects (no mocking
// library). It calls GET /api/v1/credits with the user's decrypted key as a bearer
// and normalizes { data: { total_credits, total_usage } } → { totalCredits,
// totalUsage }.

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

describe("makeOpenRouterClient.getCredits", () => {
  it("GETs /api/v1/credits with a Bearer key and normalizes the payload", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ data: { total_credits: 100, total_usage: 12.5 } }),
          { status: 200 },
        ),
    );
    const client = makeOpenRouterClient({
      apiBaseUrl: "https://openrouter.ai",
      fetchImpl,
    });

    const result = await client.getCredits("sk-or-v1-secret");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/credits");
    expect(calls[0].auth).toBe("Bearer sk-or-v1-secret");
    expect(result).toEqual({ totalCredits: 100, totalUsage: 12.5 });
  });

  it("trims a trailing slash on the base URL", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ data: { total_credits: 5, total_usage: 1 } }),
          { status: 200 },
        ),
    );
    const client = makeOpenRouterClient({
      apiBaseUrl: "https://openrouter.ai/",
      fetchImpl,
    });
    await client.getCredits("k");
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/credits");
  });

  it("throws on a non-2xx upstream response (e.g. 401 for a revoked key)", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ error: "x" }), { status: 401 }),
    );
    const client = makeOpenRouterClient({
      apiBaseUrl: "https://openrouter.ai",
      fetchImpl,
    });
    await expect(client.getCredits("k")).rejects.toThrow();
  });

  it("throws when the upstream shape is unexpected", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    );
    const client = makeOpenRouterClient({
      apiBaseUrl: "https://openrouter.ai",
      fetchImpl,
    });
    await expect(client.getCredits("k")).rejects.toThrow();
  });
});
