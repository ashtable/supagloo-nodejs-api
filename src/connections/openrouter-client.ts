import { z } from "zod";

/**
 * OpenRouter HTTP client (design-delta §2.5/§8). Mirrors `github-app-client.ts` /
 * `auth/youversion.ts`: an injectable `fetch`, closures over the base URL,
 * unit-tested with hand-built `Response` objects (no mocking library).
 *
 * The only endpoint here is the live credit balance: `GET /api/v1/credits` with the
 * user's DECRYPTED key as a bearer. The balance is never stored — it is proxied on
 * demand and reshaped by the connection service.
 */

export interface OpenRouterCredits {
  totalCredits: number;
  totalUsage: number;
}

export interface OpenRouterClient {
  /** Live credit balance for `apiKey` (the caller passes the DECRYPTED key). */
  getCredits(apiKey: string): Promise<OpenRouterCredits>;
}

export interface MakeOpenRouterClientOptions {
  /** e.g. `https://openrouter.ai` (the `/api/v1` path is appended here). */
  apiBaseUrl: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const creditsSchema = z.object({
  data: z.object({
    total_credits: z.number(),
    total_usage: z.number(),
  }),
});

export function makeOpenRouterClient(
  options: MakeOpenRouterClientOptions,
): OpenRouterClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");

  return {
    async getCredits(apiKey) {
      const res = await fetchImpl(`${apiBaseUrl}/api/v1/credits`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      });
      if (!res.ok) {
        throw new Error(`OpenRouter credits request failed: ${res.status}`);
      }
      const raw = creditsSchema.parse(await res.json());
      return {
        totalCredits: raw.data.total_credits,
        totalUsage: raw.data.total_usage,
      };
    },
  };
}
