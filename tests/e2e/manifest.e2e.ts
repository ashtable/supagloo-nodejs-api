import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  createPrismaClient,
  buildBlankManifest,
  type PrismaClient,
  type Project,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { makeGithubAppClient } from "../../src/connections/github-app-client";
import { ProjectsService } from "../../src/projects/projects-service";
import { ManifestService } from "../../src/manifests/manifest-service";

// Non-UI e2e for the manifest read (Task #20, design-delta §5.3/§8). Boots the REAL
// Fastify app in-process (real listen + real fetch) wired to the REAL Compose Postgres
// (`supagloo` DB) and the REAL containerized GitHub stub (host port 4801). No mocking —
// the manifest is read over real HTTP from the stub's Contents API (seeded via the
// stub's `POST /__admin/contents`). Users are seeded via `/v1/test/seed`;
// Project + GithubConnection rows are created directly with the test's own Prisma
// client. Runs IN-PROCESS per the in-flight-dblib-e2e constraint (the containerized API
// can't yet see the uncommitted db-lib DTOs). Infra ensured by
// tests/e2e/global-setup.ts (reuse-or-spawn: postgres + the github stub).

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";
const GITHUB_BASE = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";

const MANIFEST_PATH = "supagloo.project.json";
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe("e2e: manifest read", () => {
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
    const projectsService = new ProjectsService({ prisma });
    const githubAppClient = makeGithubAppClient({
      apiBaseUrl: GITHUB_BASE,
      appId: "123456",
      privateKey,
    });
    const manifestService = new ManifestService({
      getProject: (userId, id) => projectsService.getProject(userId, id),
      prisma,
      getFileContents: githubAppClient.getRepositoryFileContents,
    });

    app = buildApp({
      auth: {
        authService,
        env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
      },
      projects: { service: projectsService },
      manifests: { service: manifestService },
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
    const s = stamp();
    const token = `manifest-e2e-${tag}-${s}`;
    const res = await fetch(`${baseUrl}/v1/test/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        users: [
          {
            youversionUserId: `yv-manifest-${tag}-${s}`,
            displayName: `Manifest E2E ${tag}`,
            email: `manifest-${tag}-${s}@example.test`,
            avatarInitials: "ME",
            sessionToken: token,
          },
        ],
      }),
    });
    const body = await res.json();
    return { token, userId: body.users[0].user.id };
  }

  async function connectGithub(userId: string, installationId = "42"): Promise<void> {
    await prisma.githubConnection.create({
      data: {
        userId,
        githubLogin: "acme",
        installationId,
        repositorySelection: "selected",
        status: "connected",
        connectedAt: new Date(),
      },
    });
  }

  async function makeProject(
    ownerId: string,
    opts: { repoName?: string; currentBranch?: string } = {},
  ): Promise<Project> {
    const repoName = opts.repoName ?? `repo-${stamp()}`;
    return prisma.project.create({
      data: {
        slug: `slug-${stamp()}`,
        ownerId,
        name: repoName,
        repoOwner: "acme",
        repoName,
        repoVisibility: "private",
        createdFrom: "blank",
        currentBranch: opts.currentBranch ?? "v0.0.1",
      },
    });
  }

  // Seed a raw file body into the github stub's in-memory Contents store.
  async function seedManifest(args: {
    repo: string;
    ref: string;
    content: string;
  }): Promise<void> {
    const res = await fetch(`${GITHUB_BASE}/__admin/contents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: "acme",
        repo: args.repo,
        ref: args.ref,
        path: MANIFEST_PATH,
        content: args.content,
      }),
    });
    expect(res.status).toBe(201);
  }

  const api = (path: string, token?: string) =>
    fetch(`${baseUrl}/v1${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  // --------------------------------------------------------------- happy path

  it("returns the Zod-parsed manifest for the working branch, minting a fresh token", async () => {
    const owner = await seedUser("ok");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "v0.0.1" });
    const manifest = {
      ...buildBlankManifest(),
      narratorVoice: { description: "Working branch narrator" },
    };
    await seedManifest({
      repo: project.repoName,
      ref: "v0.0.1",
      content: JSON.stringify(manifest),
    });

    await fetch(`${GITHUB_BASE}/__stub/reset`, { method: "POST" });
    // reset clears the seeded store too, so re-seed AFTER the reset for the count check.
    await seedManifest({
      repo: project.repoName,
      ref: "v0.0.1",
      content: JSON.stringify(manifest),
    });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest).toEqual(manifest);

    // A fresh installation token was minted for this read (never cached/stored).
    const calls = await (await fetch(`${GITHUB_BASE}/__stub/calls`)).json();
    expect(calls.state.installationTokensIssued).toBe(1);
    expect(
      calls.byRoute["GET /repos/:owner/:repo/contents/:path"],
    ).toBe(1);
  });

  it("honors an explicit ?ref= over the project's current branch", async () => {
    const owner = await seedUser("ref");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "v0.0.1" });

    const working = { ...buildBlankManifest(), narratorVoice: { description: "working" } };
    const other = { ...buildBlankManifest(), narratorVoice: { description: "v0.0.2 branch" } };
    await seedManifest({
      repo: project.repoName,
      ref: "v0.0.1",
      content: JSON.stringify(working),
    });
    await seedManifest({
      repo: project.repoName,
      ref: "v0.0.2",
      content: JSON.stringify(other),
    });

    const res = await api(`/projects/${project.id}/manifest?ref=v0.0.2`, owner.token);
    expect(res.status).toBe(200);
    expect((await res.json()).manifest).toEqual(other);
  });

  // ----------------------------------------------------- corrupted → typed 422

  it("returns a typed 422 for a manifest that is not valid JSON", async () => {
    const owner = await seedUser("badjson");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "v0.0.1" });
    await seedManifest({
      repo: project.repoName,
      ref: "v0.0.1",
      content: "{ this is not valid json",
    });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("manifest_invalid");
  });

  it("returns a typed 422 for JSON that fails ProjectManifestSchema", async () => {
    const owner = await seedUser("badschema");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "v0.0.1" });
    await seedManifest({
      repo: project.repoName,
      ref: "v0.0.1",
      content: JSON.stringify({ ...buildBlankManifest(), manifestVersion: 2 }),
    });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("manifest_invalid");
  });

  // ------------------------------------------------------------- 404 / 409 / 401

  it("404s when the manifest file is absent on the ref", async () => {
    const owner = await seedUser("missing");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "v0.0.1" });
    // No seedManifest for this repo/ref.

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("manifest_not_found");
  });

  it("409s when the project owner has no GitHub connection", async () => {
    const owner = await seedUser("noconn");
    const project = await makeProject(owner.userId, { currentBranch: "v0.0.1" });
    await seedManifest({
      repo: project.repoName,
      ref: "v0.0.1",
      content: JSON.stringify(buildBlankManifest()),
    });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(409);
  });

  it("404s a cross-owner project (never 403) and 401s without a bearer token", async () => {
    const owner = await seedUser("owner");
    const other = await seedUser("other");
    await connectGithub(other.userId);
    const project = await makeProject(owner.userId, { currentBranch: "v0.0.1" });

    expect(
      (await api(`/projects/${project.id}/manifest`, other.token)).status,
    ).toBe(404);
    expect((await api(`/projects/${project.id}/manifest`)).status).toBe(401);
  });
});
