import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  createPrismaClient,
  decryptSecret,
  type PrismaClient,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { makeGithubAppClient } from "../../src/connections/github-app-client";
import { GithubConnectionService } from "../../src/connections/github-connection-service";
import { makeOpenRouterClient } from "../../src/connections/openrouter-client";
import { makeGlooClient } from "../../src/connections/gloo-client";
import { OpenRouterConnectionService } from "../../src/connections/openrouter-connection-service";
import { GlooConnectionService } from "../../src/connections/gloo-connection-service";
import { ConnectionsService } from "../../src/connections/connections-service";
import {
  resolveConnectionSeedCreds,
  seedGlooConnection,
  seedOpenRouterConnection,
  type ConnectionSeedCreds,
} from "../../src/testing/seed-connections";

// Real-provider e2e for the OpenRouter + Gloo connection surface (Task #12, reworked
// for real providers in Task 34-E3 / design-delta §10.2/§10.3). Boots the REAL Fastify
// app in-process (real listen + real fetch) wired to REAL Postgres (Compose `supagloo`
// DB) and the app's OpenRouter/Gloo clients pointed at the LIVE hosts. There is NO
// stub middle ground: a connection is seeded through the app's OWN real connect routes
// with real credentials from the environment (`OPENROUTER_E2E_TEST_API_KEY`,
// `GLOO_CLIENT_ID`, `GLOO_CLIENT_SECRET`), so every stored ciphertext is live-valid
// (decrypts to the real key AND is usable against the live provider) — no fabricated
// ciphertexts or dummy keys survive here (§10.3). The Gloo verify-then-store mints a
// live client-credentials token on every run (a real-API assertion), and the credits
// proxy returns real OpenRouter account data.
//
// Infra (Postgres + the still-present-but-unused-by-this-spec stubs + MinIO) is ensured
// by tests/e2e/global-setup.ts. The stub containers linger until Task 34-E8 tears down
// the compose overrides; this spec no longer touches them.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";
const GITHUB_BASE = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";
// Real-provider e2e (design-delta §10.2/§10.3): the OpenRouter + Gloo clients the
// app-under-test uses point at the LIVE hosts — the same app-boot base-URL vars the
// service reads, defaulting to the real host, with NO stub-port fallback (§10.2: a
// provider is exercised for real or not at all).
const OPENROUTER_BASE =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai";
const GLOO_BASE = process.env.GLOO_BASE_URL ?? "https://platform.ai.gloo.com";

// A real 32-byte key as 64 hex chars — the same value the services encrypt AND the
// test decrypts with, to prove ciphertext-at-rest round-trips (the app's per-run
// encryption key; distinct from the provider credentials themselves).
const ENCRYPTION_KEY = randomBytes(32).toString("hex");

describe("e2e: OpenRouter + Gloo connections (real providers)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let baseUrl: string;
  let creds: ConnectionSeedCreds;

  beforeAll(async () => {
    // Fail FAST + LOUD if a required real credential is missing — a real-provider
    // suite that silently skips is a green lie (§10.8). Names the missing var.
    creds = resolveConnectionSeedCreds();

    prisma = createPrismaClient({ connectionString: APP_URL });

    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const authService = new AuthService({
      prisma,
      verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
      sessionTtlMs: SESSION_TTL_MS,
    });

    const githubAppClient = makeGithubAppClient({
      apiBaseUrl: GITHUB_BASE,
      appId: "123456",
      privateKey,
    });
    const githubService = new GithubConnectionService({
      prisma,
      verifyInstallation: githubAppClient.verifyInstallation,
      listInstallationRepos: githubAppClient.listInstallationRepos,
      oauthBaseUrl: "https://github.com",
      appSlug: "supagloo-app",
    });

    const openrouterClient = makeOpenRouterClient({ apiBaseUrl: OPENROUTER_BASE });
    const openrouterService = new OpenRouterConnectionService({
      prisma,
      getCredits: openrouterClient.getCredits,
      encryptionKey: ENCRYPTION_KEY,
    });

    const glooClient = makeGlooClient({ apiBaseUrl: GLOO_BASE });
    const glooService = new GlooConnectionService({
      prisma,
      verifyClientCredentials: glooClient.verifyClientCredentials,
      encryptionKey: ENCRYPTION_KEY,
    });

    const connectionsReader = new ConnectionsService({ prisma });

    app = buildApp({
      auth: {
        authService,
        env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
      },
      github: { service: githubService },
      connections: {
        openrouter: openrouterService,
        gloo: glooService,
        reader: connectionsReader,
      },
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  async function seedUser(): Promise<{ token: string; userId: string }> {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const token = `conn-e2e-${stamp}`;
    const res = await fetch(`${baseUrl}/v1/test/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        users: [
          {
            youversionUserId: `yv-conn-${stamp}`,
            displayName: "Conn E2E",
            email: `conn-${stamp}@example.test`,
            avatarInitials: "CN",
            sessionToken: token,
          },
        ],
      }),
    });
    const body = await res.json();
    return { token, userId: body.users[0].user.id };
  }

  const authed = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  // ---------------------------------------------------------------- OpenRouter

  it("seeds OpenRouter through the real route: stored ciphertext is LIVE-valid (decrypts to the real key, no plaintext at rest)", async () => {
    const { token, userId } = await seedUser();

    // Seed via the app's OWN connect route with the REAL key (helper wraps
    // POST /v1/connections/openrouter). No provider-side verify (§9-Q5).
    const connection = await seedOpenRouterConnection({
      baseUrl,
      token,
      key: creds.openrouterKey,
    });
    expect(connection.keyLast4).toBe(creds.openrouterKey.slice(-4));
    expect(connection.status).toBe("connected");
    // The wire body carries the masked last4 only — never the key or its ciphertext.
    expect(JSON.stringify(connection)).not.toMatch(/ciphertext/i);
    expect(JSON.stringify(connection)).not.toContain(creds.openrouterKey);

    // Read the row from Postgres: the key at rest is ciphertext ≠ plaintext...
    const row = (await prisma.openRouterConnection.findUnique({
      where: { userId },
    })) as Record<string, any> | null;
    expect(row).not.toBeNull();
    expect(row!.apiKeyCiphertext).not.toBe(creds.openrouterKey);
    expect(String(row!.apiKeyCiphertext).includes(creds.openrouterKey)).toBe(false);
    expect(row!.keyLast4).toBe(creds.openrouterKey.slice(-4));
    // ...and it round-trips to the REAL, live-valid key (proven "usable" by the
    // credits test, which decrypts this same ciphertext and calls live OpenRouter).
    expect(decryptSecret(row!.apiKeyCiphertext, ENCRYPTION_KEY)).toBe(
      creds.openrouterKey,
    );
    // Column set carries no plaintext key.
    expect(new Set(Object.keys(row!))).toEqual(
      new Set(["userId", "apiKeyCiphertext", "keyLast4", "status", "connectedAt"]),
    );
  });

  it("proxies LIVE OpenRouter credits: real account balance with the reshaped `remaining`", async () => {
    const { token } = await seedUser();
    await seedOpenRouterConnection({ baseUrl, token, key: creds.openrouterKey });

    const res = await authed(
      "GET",
      "/v1/connections/openrouter/credits",
      token,
    );
    expect(res.status).toBe(200);

    // Structural assertion on the REAL payload (balances vary run-to-run, so we assert
    // shape + the service's `remaining = totalCredits − totalUsage` invariant, never
    // fixed values).
    const body = (await res.json()) as {
      totalCredits: number;
      totalUsage: number;
      remaining: number;
    };
    expect(typeof body.totalCredits).toBe("number");
    expect(typeof body.totalUsage).toBe("number");
    expect(typeof body.remaining).toBe("number");
    expect(Number.isFinite(body.totalCredits)).toBe(true);
    expect(Number.isFinite(body.totalUsage)).toBe(true);
    expect(Number.isFinite(body.remaining)).toBe(true);
    expect(body.remaining).toBeCloseTo(body.totalCredits - body.totalUsage, 6);
  });

  it("credits before connecting OpenRouter returns 409", async () => {
    const { token } = await seedUser();
    const res = await authed(
      "GET",
      "/v1/connections/openrouter/credits",
      token,
    );
    expect(res.status).toBe(409);
  });

  it("disconnects OpenRouter and is idempotent", async () => {
    const { token, userId } = await seedUser();
    await seedOpenRouterConnection({ baseUrl, token, key: creds.openrouterKey });

    const del = await authed("DELETE", "/v1/connections/openrouter", token);
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);
    expect(
      await prisma.openRouterConnection.findUnique({ where: { userId } }),
    ).toBeNull();

    const again = await authed("DELETE", "/v1/connections/openrouter", token);
    expect(again.status).toBe(200);
  });

  // ---------------------------------------------------------------------- Gloo

  it("connects Gloo via LIVE verify-then-store: mints a real token, stores clientId + secret ciphertext", async () => {
    const { token, userId } = await seedUser();

    // Seed via the app's OWN connect route with the REAL client credentials. The
    // route's verify-then-store mints a live Gloo token BEFORE writing — a 2xx here is
    // a real-API assertion that the mint succeeded this run.
    const connection = await seedGlooConnection({
      baseUrl,
      token,
      clientId: creds.glooClientId,
      clientSecret: creds.glooClientSecret,
    });
    expect(connection.clientId).toBe(creds.glooClientId);
    expect(connection.status).toBe("connected");
    // A real timestamp recorded at the successful live mint.
    expect(connection.lastVerifiedAt).toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(connection.lastVerifiedAt))).toBe(false);
    // No secret / ciphertext on the wire.
    expect(JSON.stringify(connection)).not.toMatch(/secret|ciphertext/i);

    // Row at rest: the secret is ciphertext ≠ plaintext, and round-trips.
    const row = (await prisma.glooConnection.findUnique({
      where: { userId },
    })) as Record<string, any> | null;
    expect(row).not.toBeNull();
    expect(row!.clientId).toBe(creds.glooClientId);
    expect(row!.clientSecretCiphertext).not.toBe(creds.glooClientSecret);
    expect(decryptSecret(row!.clientSecretCiphertext, ENCRYPTION_KEY)).toBe(
      creds.glooClientSecret,
    );
  });

  it("Gloo verify failure (statically-wrong secret against LIVE Gloo) → 400, NOTHING persisted", async () => {
    const { token, userId } = await seedUser();

    // A real, registered clientId paired with a deliberately-wrong secret (the real
    // secret with its last character flipped). Live Gloo rejects the client-credentials
    // mint with a 4xx, which the route maps to 400 — a real-API verify failure, not a
    // stub sentinel.
    const wrongSecret =
      creds.glooClientSecret.slice(0, -1) +
      (creds.glooClientSecret.endsWith("a") ? "b" : "a");

    const res = await authed("PUT", "/v1/connections/gloo", token, {
      clientId: creds.glooClientId,
      clientSecret: wrongSecret,
    });
    expect(res.status).toBe(400);

    // Verify-then-store wrote nothing (the invariant this test exists to prove).
    expect(
      await prisma.glooConnection.findUnique({ where: { userId } }),
    ).toBeNull();
  });

  it("disconnects Gloo and is idempotent", async () => {
    const { token, userId } = await seedUser();
    await seedGlooConnection({
      baseUrl,
      token,
      clientId: creds.glooClientId,
      clientSecret: creds.glooClientSecret,
    });

    const del = await authed("DELETE", "/v1/connections/gloo", token);
    expect(del.status).toBe(200);
    expect(
      await prisma.glooConnection.findUnique({ where: { userId } }),
    ).toBeNull();

    const again = await authed("DELETE", "/v1/connections/gloo", token);
    expect(again.status).toBe(200);
  });

  // -------------------------------------------------------------------- merged

  it("merged GET /v1/connections reports all three providers (masked, no secrets)", async () => {
    const { token } = await seedUser();

    // Nothing connected yet → all null.
    const before = await (
      await authed("GET", "/v1/connections", token)
    ).json();
    expect(before).toEqual({ github: null, openrouter: null, gloo: null });

    // Seed both through the real routes with real credentials.
    await seedOpenRouterConnection({ baseUrl, token, key: creds.openrouterKey });
    await seedGlooConnection({
      baseUrl,
      token,
      clientId: creds.glooClientId,
      clientSecret: creds.glooClientSecret,
    });

    const after = await (
      await authed("GET", "/v1/connections", token)
    ).json();
    expect(after.github).toBeNull();
    expect(after.openrouter.keyLast4).toBe(creds.openrouterKey.slice(-4));
    expect(after.openrouter.apiKeyCiphertext).toBeUndefined();
    expect(after.gloo.clientId).toBe(creds.glooClientId);
    expect(after.gloo.clientSecretCiphertext).toBeUndefined();
    expect(JSON.stringify(after)).not.toMatch(/ciphertext/i);
  });
});
