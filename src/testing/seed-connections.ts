/**
 * E2E connection-seeding helper (design-delta §10.3).
 *
 * The api e2e seeds provider connections by calling the app's OWN real connect
 * routes — `POST /v1/connections/openrouter` and `PUT /v1/connections/gloo` — which
 * ARE the surface under test. Seeding through them (rather than fabricating DB rows)
 * guarantees every stored ciphertext is LIVE-VALID: the OpenRouter key decrypts to a
 * real key the credits proxy can use, and the Gloo credentials pass a real
 * verify-then-store mint on every run. There are no fabricated ciphertexts or dummy
 * keys anywhere in the api e2e as a result.
 *
 * This module is TEST-ONLY infrastructure (imported by
 * `tests/e2e/connections.e2e.ts`) and is excluded from the shipped `dist/` build. Its
 * failure-mode logic is deliberately factored out here — not inlined in the e2e spec —
 * so it can be unit-tested with an INJECTED `fetch` + INJECTED env
 * (`seed-connections.test.ts`) without a live provider:
 *   • missing secret          → actionable setup error naming the var
 *   • failed live Gloo verify  → setup aborts (surfaced, never swallowed/retried)
 */

export const OPENROUTER_E2E_KEY_VAR = "OPENROUTER_E2E_TEST_API_KEY";
export const GLOO_CLIENT_ID_VAR = "GLOO_CLIENT_ID";
export const GLOO_CLIENT_SECRET_VAR = "GLOO_CLIENT_SECRET";

/**
 * The environment variables this helper requires, in a stable order. Single source
 * of truth for the fail-fast validation and for `.env.example` consistency.
 */
export const CONNECTION_SEED_ENV_VARS = [
  OPENROUTER_E2E_KEY_VAR,
  GLOO_CLIENT_ID_VAR,
  GLOO_CLIENT_SECRET_VAR,
] as const;

export interface ConnectionSeedCreds {
  /** Real OpenRouter API key (`OPENROUTER_E2E_TEST_API_KEY`) — dedicated low-balance. */
  openrouterKey: string;
  /** Real, live-verifiable Gloo OAuth2 client id (`GLOO_CLIENT_ID`). */
  glooClientId: string;
  /** Real, live-verifiable Gloo OAuth2 client secret (`GLOO_CLIENT_SECRET`). */
  glooClientSecret: string;
}

type EnvSource = Record<string, string | undefined>;

/**
 * Resolve the three real provider credentials from the environment, failing FAST
 * with an actionable message naming any missing/empty var. An empty or whitespace
 * value is treated as missing. Pure + env-injectable for unit testing.
 */
export function resolveConnectionSeedCreds(
  env: EnvSource = process.env,
): ConnectionSeedCreds {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `E2E connection seeding requires the environment variable ${name} to be set ` +
          `to a live-valid provider credential (see .env.example / design-delta §10.8), ` +
          `but it is missing or empty. Export the e2e secrets before running the ` +
          `real-provider suite, e.g. \`set -a; . ./.env; set +a\`. The real-provider ` +
          `e2e must never silently skip — a green suite that skipped is a lie.`,
      );
    }
    return value;
  };
  return {
    openrouterKey: read(OPENROUTER_E2E_KEY_VAR),
    glooClientId: read(GLOO_CLIENT_ID_VAR),
    glooClientSecret: read(GLOO_CLIENT_SECRET_VAR),
  };
}

export interface SeedConnectionHttpOptions {
  /** Base URL of the app under test (real listening Fastify instance). */
  baseUrl: string;
  /** Bearer session token for the seeded user (from `POST /v1/test/seed`). */
  token: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface SeededOpenRouterConnection {
  keyLast4: string;
  status: string;
  connectedAt: string;
}

export interface SeededGlooConnection {
  clientId: string;
  status: string;
  connectedAt: string;
  lastVerifiedAt: string;
}

async function describeBody(res: Response): Promise<string> {
  try {
    return JSON.stringify(await res.json());
  } catch {
    return "<unparseable response body>";
  }
}

/**
 * Seed the user's OpenRouter connection via the real `POST /v1/connections/openrouter`
 * route with a live key. The route performs NO provider-side verify (the key was
 * browser-PKCE-obtained), so a 2xx simply means the key was encrypted + stored; the
 * ciphertext is nonetheless live-valid because `key` is the real test key. Throws
 * (aborts seeding) on any non-2xx.
 */
export async function seedOpenRouterConnection(
  opts: SeedConnectionHttpOptions & { key: string },
): Promise<SeededOpenRouterConnection> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.baseUrl}/v1/connections/openrouter`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ key: opts.key }),
  });
  if (!res.ok) {
    throw new Error(
      `E2E connection seeding: POST /v1/connections/openrouter failed ` +
        `(${res.status}) — could not seed the OpenRouter connection. ` +
        `Body: ${await describeBody(res)}`,
    );
  }
  const { connection } = (await res.json()) as {
    connection: SeededOpenRouterConnection;
  };
  return connection;
}

/**
 * Seed the user's Gloo connection via the real `PUT /v1/connections/gloo` route with
 * live client credentials. The route's VERIFY-THEN-STORE mints a real
 * client-credentials token before writing anything, so a non-2xx (typically 400)
 * means the LIVE Gloo verify rejected the credentials and NO row was written. The
 * helper surfaces that as an aborted seed — it never swallows or retries past the
 * failure. Throws on any non-2xx.
 */
export async function seedGlooConnection(
  opts: SeedConnectionHttpOptions & { clientId: string; clientSecret: string },
): Promise<SeededGlooConnection> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.baseUrl}/v1/connections/gloo`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${opts.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `E2E connection seeding: PUT /v1/connections/gloo failed (${res.status}). ` +
        `The live Gloo verify-then-store rejected the client credentials, so NO row ` +
        `was stored — aborting the seed rather than continuing. Check that ` +
        `${GLOO_CLIENT_ID_VAR}/${GLOO_CLIENT_SECRET_VAR} are live-valid. ` +
        `Body: ${await describeBody(res)}`,
    );
  }
  const { connection } = (await res.json()) as {
    connection: SeededGlooConnection;
  };
  return connection;
}

export interface SeededConnections {
  /** The real credentials used to seed — returned so callers can decrypt-assert. */
  creds: ConnectionSeedCreds;
  openrouter: SeededOpenRouterConnection;
  gloo: SeededGlooConnection;
}

/**
 * Seed BOTH provider connections for a user through the app's own real routes.
 * Resolves the real credentials from the environment FIRST (fail-fast before any
 * network call), then seeds OpenRouter (no provider verify), then Gloo (live
 * verify-then-store). A Gloo verify failure aborts the whole seed.
 */
export async function seedConnections(
  opts: SeedConnectionHttpOptions & { env?: EnvSource },
): Promise<SeededConnections> {
  const creds = resolveConnectionSeedCreds(opts.env ?? process.env);
  const http: SeedConnectionHttpOptions = {
    baseUrl: opts.baseUrl,
    token: opts.token,
    fetchImpl: opts.fetchImpl,
  };
  const openrouter = await seedOpenRouterConnection({
    ...http,
    key: creds.openrouterKey,
  });
  const gloo = await seedGlooConnection({
    ...http,
    clientId: creds.glooClientId,
    clientSecret: creds.glooClientSecret,
  });
  return { creds, openrouter, gloo };
}
