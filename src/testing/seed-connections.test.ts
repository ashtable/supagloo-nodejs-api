import { describe, it, expect, vi } from "vitest";
import {
  CONNECTION_SEED_ENV_VARS,
  OPENROUTER_E2E_KEY_VAR,
  GLOO_CLIENT_ID_VAR,
  GLOO_CLIENT_SECRET_VAR,
  resolveConnectionSeedCreds,
  seedConnections,
  seedGlooConnection,
  seedOpenRouterConnection,
} from "./seed-connections";

// Unit tests for the e2e connection-seeding helper (design-delta §10.3). These run
// in the fast, DOCKER-FREE unit lane with an INJECTED fetch + INJECTED env — no live
// provider, no real HTTP. They pin the two failure modes plan.md requires:
//   • missing secret        → actionable setup error (names the var)
//   • failed live Gloo verify → setup aborts, no row written (surfaces, no swallow)

const FULL_ENV = {
  [OPENROUTER_E2E_KEY_VAR]: "sk-or-v1-real-test-key-abcd",
  [GLOO_CLIENT_ID_VAR]: "real-gloo-client",
  [GLOO_CLIENT_SECRET_VAR]: "real-gloo-secret",
};

/** A fetch double whose responses are keyed by `${method} ${pathname}`. Records
 *  every call so ordering/abort behavior is assertable. */
function makeFetchStub(
  routes: Record<string, () => Response>,
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const routeKey = `${method} ${url.pathname}`;
    calls.push(routeKey);
    const handler = routes[routeKey];
    if (!handler) throw new Error(`unexpected request in stub: ${routeKey}`);
    return handler();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("resolveConnectionSeedCreds", () => {
  it("returns the three creds when every var is present", () => {
    expect(resolveConnectionSeedCreds(FULL_ENV)).toEqual({
      openrouterKey: "sk-or-v1-real-test-key-abcd",
      glooClientId: "real-gloo-client",
      glooClientSecret: "real-gloo-secret",
    });
  });

  it.each(CONNECTION_SEED_ENV_VARS)(
    "throws an actionable error naming %s when it is missing",
    (missing) => {
      const env = { ...FULL_ENV };
      delete (env as Record<string, string>)[missing];
      expect(() => resolveConnectionSeedCreds(env)).toThrowError(
        new RegExp(missing),
      );
    },
  );

  it("treats an empty-string var as missing", () => {
    const env = { ...FULL_ENV, [GLOO_CLIENT_SECRET_VAR]: "   " };
    expect(() => resolveConnectionSeedCreds(env)).toThrowError(
      new RegExp(GLOO_CLIENT_SECRET_VAR),
    );
  });
});

describe("seedConnections — failure modes (injected fetch)", () => {
  it("fails fast on a missing secret BEFORE any network call", async () => {
    const fetchImpl = vi.fn();
    const env = { ...FULL_ENV };
    delete (env as Record<string, string>)[OPENROUTER_E2E_KEY_VAR];

    await expect(
      seedConnections({
        baseUrl: "http://app.test",
        token: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env,
      }),
    ).rejects.toThrow(new RegExp(OPENROUTER_E2E_KEY_VAR));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts (surfaces, does not swallow) when the live Gloo verify fails, writing no row", async () => {
    const { fetchImpl, calls } = makeFetchStub({
      "POST /v1/connections/openrouter": () =>
        json(200, {
          connection: {
            keyLast4: "abcd",
            status: "connected",
            connectedAt: new Date().toISOString(),
          },
        }),
      "PUT /v1/connections/gloo": () =>
        json(400, {
          error: "invalid_gloo_credentials",
          message: "Gloo client credentials could not be verified",
        }),
    });

    const promise = seedConnections({
      baseUrl: "http://app.test",
      token: "tok",
      fetchImpl,
      env: FULL_ENV,
    });

    await expect(promise).rejects.toThrow(/gloo/i);
    // Got as far as the Gloo PUT (OpenRouter first), then aborted AT it — no retry,
    // no continuation past the failure.
    expect(calls).toEqual([
      "POST /v1/connections/openrouter",
      "PUT /v1/connections/gloo",
    ]);
  });
});

describe("single-provider seed helpers (injected fetch)", () => {
  it("seedOpenRouterConnection returns the DTO on 200", async () => {
    const { fetchImpl } = makeFetchStub({
      "POST /v1/connections/openrouter": () =>
        json(200, {
          connection: {
            keyLast4: "wxyz",
            status: "connected",
            connectedAt: "2026-07-23T00:00:00.000Z",
          },
        }),
    });
    const dto = await seedOpenRouterConnection({
      baseUrl: "http://app.test",
      token: "tok",
      key: "sk-or-v1-real-test-key-wxyz",
      fetchImpl,
    });
    expect(dto.keyLast4).toBe("wxyz");
    expect(dto.status).toBe("connected");
  });

  it("seedOpenRouterConnection throws (aborts) on a non-2xx", async () => {
    const { fetchImpl } = makeFetchStub({
      "POST /v1/connections/openrouter": () => json(401, { error: "unauthorized" }),
    });
    await expect(
      seedOpenRouterConnection({
        baseUrl: "http://app.test",
        token: "tok",
        key: "sk-or-v1-bad",
        fetchImpl,
      }),
    ).rejects.toThrow(/openrouter/i);
  });

  it("seedGlooConnection returns the DTO on 200 (live verify-then-store succeeded)", async () => {
    const { fetchImpl } = makeFetchStub({
      "PUT /v1/connections/gloo": () =>
        json(200, {
          connection: {
            clientId: "real-gloo-client",
            status: "connected",
            connectedAt: "2026-07-23T00:00:00.000Z",
            lastVerifiedAt: "2026-07-23T00:00:00.000Z",
          },
        }),
    });
    const dto = await seedGlooConnection({
      baseUrl: "http://app.test",
      token: "tok",
      clientId: "real-gloo-client",
      clientSecret: "real-gloo-secret",
      fetchImpl,
    });
    expect(dto.clientId).toBe("real-gloo-client");
    expect(dto.lastVerifiedAt).toBeTypeOf("string");
  });
});
