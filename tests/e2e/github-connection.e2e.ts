import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createPrismaClient, type PrismaClient } from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { makeGithubAppClient } from "../../src/connections/github-app-client";
import { GithubConnectionService } from "../../src/connections/github-connection-service";

// Non-UI e2e for the GitHub App connection (Task #11). Boots the REAL Fastify app
// in-process (real listen + real fetch), wired to REAL Postgres (Compose
// `supagloo` DB) and the REAL containerized GitHub stub (host port 4801). No
// mocking — the stub is a real HTTP server; the DB is real Postgres. The App JWT
// is signed with a real RSA keypair generated here. Infra ensured by
// tests/e2e/global-setup.ts (reuse-or-spawn: postgres + youversion + github stubs).

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";
const GITHUB_BASE = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";

const OAUTH_BASE = "https://github.com";
const APP_SLUG = "supagloo-app";

describe("e2e: GitHub App connection", () => {
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

    const appClient = makeGithubAppClient({
      apiBaseUrl: GITHUB_BASE,
      appId: "123456",
      privateKey,
    });
    const githubService = new GithubConnectionService({
      prisma,
      verifyInstallation: appClient.verifyInstallation,
      listInstallationRepos: appClient.listInstallationRepos,
      oauthBaseUrl: OAUTH_BASE,
      appSlug: APP_SLUG,
    });

    app = buildApp({
      auth: {
        authService,
        env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
      },
      github: { service: githubService },
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  // Seed a fresh user + session; returns the bearer token + userId.
  async function seedUser(): Promise<{ token: string; userId: string }> {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const token = `gh-e2e-${stamp}`;
    const res = await fetch(`${baseUrl}/v1/test/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        users: [
          {
            youversionUserId: `yv-gh-${stamp}`,
            displayName: "GH E2E",
            email: `gh-${stamp}@example.test`,
            avatarInitials: "GH",
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

  it("install-url returns the hosted picker URL and requires auth", async () => {
    const { token } = await seedUser();

    const noAuth = await fetch(`${baseUrl}/v1/connections/github/install-url`);
    expect(noAuth.status).toBe(401);

    const res = await authed("GET", "/v1/connections/github/install-url", token);
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(url).toContain(`/apps/${APP_SLUG}/installations/new`);
    expect(url.startsWith(OAUTH_BASE)).toBe(true);
  });

  it("callback verifies via App JWT and stores ONLY installationId + githubLogin (no token column)", async () => {
    const { token, userId } = await seedUser();

    const res = await authed(
      "POST",
      "/v1/connections/github/callback",
      token,
      { installationId: "42" },
    );
    expect(res.status).toBe(200);
    const { connection } = await res.json();
    expect(connection.installationId).toBe("42");
    expect(connection.githubLogin).toBe("acme");
    expect(["all", "selected"]).toContain(connection.repositorySelection);
    expect(connection.status).toBe("connected");

    // Read the row straight from Postgres: only the 6 design columns, no token.
    const row = (await prisma.githubConnection.findUnique({
      where: { userId },
    })) as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(new Set(Object.keys(row!))).toEqual(
      new Set([
        "userId",
        "githubLogin",
        "installationId",
        "repositorySelection",
        "status",
        "connectedAt",
      ]),
    );
    expect(Object.keys(row!).join(",")).not.toMatch(/token|ciphertext|secret/i);
  });

  it("repos mints a FRESH installation token per request (never cached/stored)", async () => {
    const { token } = await seedUser();
    await authed("POST", "/v1/connections/github/callback", token, {
      installationId: "42",
    });

    // Reset the stub's counters, then list twice.
    await fetch(`${GITHUB_BASE}/__stub/reset`, { method: "POST" });
    const a = await authed("GET", "/v1/github/repos?filter=all", token);
    const b = await authed("GET", "/v1/github/repos?filter=all", token);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const calls = await (await fetch(`${GITHUB_BASE}/__stub/calls`)).json();
    // One token minted per call — no caching.
    expect(calls.state.installationTokensIssued).toBe(2);
    expect(calls.byRoute["GET /installation/repositories"]).toBe(2);
  });

  it("filter=empty and q= narrow the live listing", async () => {
    const { token } = await seedUser();
    await authed("POST", "/v1/connections/github/callback", token, {
      installationId: "42",
    });

    const all = await (
      await authed("GET", "/v1/github/repos?filter=all", token)
    ).json();
    expect(all.repositories.length).toBeGreaterThan(1);

    const empty = await (
      await authed("GET", "/v1/github/repos?filter=empty", token)
    ).json();
    expect(empty.repositories.length).toBeGreaterThan(0);
    expect(empty.repositories.every((r: any) => r.empty === true)).toBe(true);

    const q = await (
      await authed("GET", "/v1/github/repos?filter=all&q=psalm", token)
    ).json();
    expect(q.repositories.length).toBeGreaterThan(0);
    expect(
      q.repositories.every((r: any) => /psalm/i.test(r.fullName)),
    ).toBe(true);
  });

  it("listing repos before connecting GitHub returns 409", async () => {
    const { token } = await seedUser();
    const res = await authed("GET", "/v1/github/repos?filter=all", token);
    expect(res.status).toBe(409);
  });

  it("disconnect removes the row and is idempotent", async () => {
    const { token, userId } = await seedUser();
    await authed("POST", "/v1/connections/github/callback", token, {
      installationId: "42",
    });

    const del = await authed("DELETE", "/v1/connections/github", token);
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);
    expect(
      await prisma.githubConnection.findUnique({ where: { userId } }),
    ).toBeNull();

    // Second delete still succeeds (idempotent).
    const again = await authed("DELETE", "/v1/connections/github", token);
    expect(again.status).toBe(200);
  });
});
