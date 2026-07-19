/**
 * Gloo HTTP client (design-delta §2.5/§8). Injectable `fetch`, closures over the
 * base URL, unit-tested with hand-built `Response` objects (no mocking library).
 *
 * `verifyClientCredentials` is the "client-credentials test mint": it POSTs the
 * OAuth2 `client_credentials` grant to `/oauth2/token` with the pair as HTTP Basic
 * auth. This is a VERIFY-ONLY call — the minted token is discarded (never persisted);
 * we only care that the pair is valid. A 2xx means valid; a 4xx (e.g. 401
 * `invalid_client`) means the credentials are bad; anything else is an unexpected
 * upstream failure that must surface rather than be mistaken for a bad-credential
 * rejection.
 */

export interface GlooClient {
  /** True iff the client-credentials pair mints a token; false on a 4xx credential
   *  rejection. Throws on an unexpected (5xx/network) upstream failure. */
  verifyClientCredentials(args: {
    clientId: string;
    clientSecret: string;
  }): Promise<boolean>;
}

export interface MakeGlooClientOptions {
  /** e.g. `https://platform.ai.gloo.com` (the `/oauth2/token` path is appended). */
  apiBaseUrl: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export function makeGlooClient(options: MakeGlooClientOptions): GlooClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");

  return {
    async verifyClientCredentials({ clientId, clientSecret }) {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString(
        "base64",
      );
      const res = await fetchImpl(`${apiBaseUrl}/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });
      if (res.ok) return true;
      // A 4xx is an EXPECTED credential rejection (bad clientId/secret). A 5xx (or
      // anything else) is an unexpected upstream failure — surface it, don't record
      // it as a verify failure.
      if (res.status >= 400 && res.status < 500) return false;
      throw new Error(`Gloo token mint failed: ${res.status}`);
    },
  };
}
