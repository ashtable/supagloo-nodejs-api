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

// Non-UI e2e for the OpenRouter + Gloo connection surface (Task #12). Boots the
// REAL Fastify app in-process (real listen + real fetch) wired to REAL Postgres
// (Compose `supagloo` DB) and the REAL containerized OpenRouter (:4802) + Gloo
// (:4803) stubs. No mocking — the stubs are real HTTP servers; the DB is real
// Postgres; the crypto key is a real 64-hex key generated here. Infra ensured by
// tests/e2e/global-setup.ts (reuse-or-spawn: postgres + youversion + github +
// openrouter + gloo stubs).

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";
const GITHUB_BASE = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";
const OPENROUTER_BASE =
  process.env.OPENROUTER_STUB_URL ?? "http://localhost:4802";
const GLOO_BASE = process.env.GLOO_STUB_URL ?? "http://localhost:4803";

// A real 32-byte key as 64 hex chars — the same value the services encrypt AND the
// test decrypts with, to prove ciphertext-at-rest round-trips.
const ENCRYPTION_KEY = randomBytes(32).toString("hex");

describe("e2e: OpenRouter + Gloo connections", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
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

  it("connects OpenRouter: stores CIPHERTEXT (not the key) + keyLast4", async () => {
    const { token, userId } = await seedUser();
    const key = "sk-or-v1-e2e-supersecret-abcd";

    const res = await authed("POST", "/v1/connections/openrouter", token, { key });
    expect(res.status).toBe(200);
    const { connection } = await res.json();
    expect(connection.keyLast4).toBe("abcd");
    expect(connection.status).toBe("connected");
    // No ciphertext on the wire.
    expect(JSON.stringify(connection)).not.toMatch(/ciphertext/i);

    // Read the row from Postgres: the key at rest is ciphertext ≠ plaintext.
    const row = (await prisma.openRouterConnection.findUnique({
      where: { userId },
    })) as Record<string, any> | null;
    expect(row).not.toBeNull();
    expect(row!.apiKeyCiphertext).not.toBe(key);
    expect(String(row!.apiKeyCiphertext).includes(key)).toBe(false);
    expect(row!.keyLast4).toBe("abcd");
    // ...but it round-trips with the encryption key.
    expect(decryptSecret(row!.apiKeyCiphertext, ENCRYPTION_KEY)).toBe(key);
    // Column set carries no plaintext key.
    expect(new Set(Object.keys(row!))).toEqual(
      new Set(["userId", "apiKeyCiphertext", "keyLast4", "status", "connectedAt"]),
    );
  });

  it("proxies live credits to the OpenRouter stub and reshapes with remaining", async () => {
    const { token } = await seedUser();
    await authed("POST", "/v1/connections/openrouter", token, {
      key: "sk-or-v1-credits-key-0000",
    });

    await fetch(`${OPENROUTER_BASE}/__stub/reset`, { method: "POST" });
    const res = await authed(
      "GET",
      "/v1/connections/openrouter/credits",
      token,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totalCredits: 100,
      totalUsage: 12.5,
      remaining: 87.5,
    });

    // The proxy actually hit the stub's credits endpoint.
    const calls = await (
      await fetch(`${OPENROUTER_BASE}/__stub/calls`)
    ).json();
    expect(calls.byRoute["GET /api/v1/credits"]).toBe(1);
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
    await authed("POST", "/v1/connections/openrouter", token, {
      key: "sk-or-v1-del-key-1111",
    });

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

  it("connects Gloo via verify-then-store: mints a token, stores clientId + secret ciphertext", async () => {
    const { token, userId } = await seedUser();
    await fetch(`${GLOO_BASE}/__stub/reset`, { method: "POST" });

    const res = await authed("PUT", "/v1/connections/gloo", token, {
      clientId: "gloo-e2e-client",
      clientSecret: "gloo-e2e-secret-xyz",
    });
    expect(res.status).toBe(200);
    const { connection } = await res.json();
    expect(connection.clientId).toBe("gloo-e2e-client");
    expect(connection.status).toBe("connected");
    expect(connection.lastVerifiedAt).toBeTypeOf("string");
    // No secret / ciphertext on the wire.
    expect(JSON.stringify(connection)).not.toMatch(/secret|ciphertext/i);

    // The client-credentials mint actually hit the stub.
    const calls = await (await fetch(`${GLOO_BASE}/__stub/calls`)).json();
    expect(calls.byRoute["POST /oauth2/token"]).toBe(1);

    // Row at rest: the secret is ciphertext ≠ plaintext, and round-trips.
    const row = (await prisma.glooConnection.findUnique({
      where: { userId },
    })) as Record<string, any> | null;
    expect(row).not.toBeNull();
    expect(row!.clientId).toBe("gloo-e2e-client");
    expect(row!.clientSecretCiphertext).not.toBe("gloo-e2e-secret-xyz");
    expect(decryptSecret(row!.clientSecretCiphertext, ENCRYPTION_KEY)).toBe(
      "gloo-e2e-secret-xyz",
    );
  });

  it("Gloo verify failure leaves NO row (400, nothing persisted)", async () => {
    const { token, userId } = await seedUser();

    const res = await authed("PUT", "/v1/connections/gloo", token, {
      // The stub's reserved sentinel clientId → 401 invalid_client → verify fails.
      clientId: "gloo-invalid",
      clientSecret: "whatever",
    });
    expect(res.status).toBe(400);

    // Nothing was written.
    expect(
      await prisma.glooConnection.findUnique({ where: { userId } }),
    ).toBeNull();
  });

  it("disconnects Gloo and is idempotent", async () => {
    const { token, userId } = await seedUser();
    await authed("PUT", "/v1/connections/gloo", token, {
      clientId: "gloo-del-client",
      clientSecret: "gloo-del-secret",
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

    await authed("POST", "/v1/connections/openrouter", token, {
      key: "sk-or-v1-merged-key-9999",
    });
    await authed("PUT", "/v1/connections/gloo", token, {
      clientId: "gloo-merged-client",
      clientSecret: "gloo-merged-secret",
    });

    const after = await (
      await authed("GET", "/v1/connections", token)
    ).json();
    expect(after.github).toBeNull();
    expect(after.openrouter.keyLast4).toBe("9999");
    expect(after.openrouter.apiKeyCiphertext).toBeUndefined();
    expect(after.gloo.clientId).toBe("gloo-merged-client");
    expect(after.gloo.clientSecretCiphertext).toBeUndefined();
    expect(JSON.stringify(after)).not.toMatch(/ciphertext/i);
  });
});
