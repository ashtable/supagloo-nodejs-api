import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import {
  githubApiBaseUrl,
  mintE2eInstallationToken,
  provisionFixtureRepo,
  resolveGithubE2eContext,
  seedGithubConnection,
  seedRepoFileOnBranch,
  type FixtureRepo,
  type GithubE2eContext,
} from "../../src/testing/github-e2e";

// Non-UI e2e for the manifest read (Task #20, design-delta §5.3/§8), REPOINTED AT REAL
// GITHUB in task-62 (design-delta §11 / D11). Boots the REAL Fastify app in-process
// (real listen + real fetch) wired to the REAL Compose Postgres (`supagloo` DB) and to
// **real api.github.com**. The manifest is read over real HTTPS from GitHub's own
// Contents API. Runs IN-PROCESS per the in-flight-dblib-e2e constraint (the
// containerized API can't yet see the uncommitted db-lib DTOs). Infra ensured by
// tests/e2e/global-setup.ts (Postgres + MinIO — GitHub needs no local service).
//
// WHAT REPLACED THE STUB'S `POST /__admin/contents` (task-62 D11)
// ONE throwaway repo per run (root's `buildE2eRepoName("manifest", runId)`, created with
// `auto_init: true` so `main` exists), plus FOUR real branches cut from `main` with the
// INSTALLATION token and real `PUT /repos/:o/:r/contents/supagloo.project.json` writes:
//
//   branch `valid`     — a real, schema-valid manifest         (happy path)
//   branch `other`     — a DIFFERENT valid manifest            (real `?ref=` semantics)
//   branch `badjson`   — the literal bytes `{ this is not valid json`
//   branch `badschema` — valid JSON that fails ProjectManifestSchema
//   branch `absent`    — created with NO manifest file         (real Contents 404)
//
// Every error case here is **file-content** injection, not provider-behaviour
// injection: a real repo holds corrupt bytes exactly as readily as a stub did, so
// nothing needed reclassifying to unit level to stay covered.
//
// The two remaining cases (409 no-connection, 404 cross-owner + 401) are ZERO-EGRESS —
// they short-circuit in the api before any GitHub call — so they seed no fixture at all.
// The stub era hid that: it seeded a manifest for the 409 case that could never be read.
//
// DELETED, NOT WEAKENED (task-62 D9): the `installationTokensIssued === 1` +
// `byRoute["GET /repos/:owner/:repo/contents/:path"] === 1` assertions, and the
// `/__stub/reset` + re-seed dance they required. Real GitHub has no per-caller call
// counter. They are RECLASSIFIED to `src/connections/github-app-client.test.ts` with an
// injected counting fetchImpl ("one getRepositoryFileContents ⇒ exactly ONE mint and
// ONE contents GET"), which attributes each call to the method that made it.
//
// Also newly in play, and impossible against the stub: the Contents API's 1 MB inline
// cap / `encoding:"none"` representation switch, and multi-segment paths (the stub only
// ever routed a single segment). Both are covered at unit level; every fixture here is
// far under the cap.
//
// DURABLE SIDE EFFECTS: one private throwaway repo per run, NEVER auto-removed
// (task-62 D6). Reclaim with the root repo's `npm run cleanup:github-e2e`.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";

const MANIFEST_PATH = "supagloo.project.json";
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** The four seeded branches + the one deliberately-empty branch. */
const VALID_MANIFEST = {
  ...buildBlankManifest(),
  narratorVoice: { description: "Working branch narrator" },
};
const OTHER_MANIFEST = {
  ...buildBlankManifest(),
  narratorVoice: { description: "the other ref" },
};

describe("e2e: manifest read (real github.com Contents API)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let baseUrl: string;
  let ctx: GithubE2eContext;
  let fixture: FixtureRepo;

  beforeAll(async () => {
    // Fail FAST + LOUD (never warn-and-skip) on a missing credential or an
    // uninstalled App — see src/testing/github-e2e.ts for the remediation text.
    ctx = await resolveGithubE2eContext();

    prisma = createPrismaClient({ connectionString: APP_URL });

    const authService = new AuthService({
      prisma,
      verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
      sessionTtlMs: SESSION_TTL_MS,
    });
    const projectsService = new ProjectsService({ prisma });
    const githubAppClient = makeGithubAppClient({
      // Real host, real App credentials. A throwaway keypair could only prove we
      // produce a well-formed JWT; the real key proves GitHub ACCEPTS it (row 62
      // item (c)'s bug class).
      apiBaseUrl: githubApiBaseUrl(),
      appId: ctx.appId,
      privateKey: ctx.privateKey,
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

    // ONE repo for all seven cases (task-62 D7: repo creation is governed by GitHub's
    // secondary/abuse limits, so the per-run creation budget is deliberately minimal).
    fixture = await provisionFixtureRepo("manifest", {
      spec: "supagloo-nodejs-api/tests/e2e/manifest.e2e.ts",
    });

    // Seeding uses the INSTALLATION token, not the PAT (task-62 D6): it exercises the
    // installation's granted `contents:write` for real, and a PAT — a strictly stronger
    // credential than production ever holds — could green-light a permission the
    // product does not actually have.
    const token = await mintE2eInstallationToken();
    const seed = (branch: string, content?: string) =>
      seedRepoFileOnBranch({
        owner: fixture.owner,
        repo: fixture.repo,
        branch,
        token,
        fromBranch: fixture.defaultBranch,
        ...(content === undefined
          ? {}
          : { path: MANIFEST_PATH, content }),
      });

    await seed("valid", JSON.stringify(VALID_MANIFEST));
    await seed("other", JSON.stringify(OTHER_MANIFEST));
    await seed("badjson", "{ this is not valid json");
    await seed(
      "badschema",
      JSON.stringify({ ...buildBlankManifest(), manifestVersion: 2 }),
    );
    // No manifest on this branch → a REAL Contents 404. `seedRepoFileOnBranch`
    // verifies the branch itself exists, because a 404 from a NON-EXISTENT ref would
    // pass this test for entirely the wrong reason (task-62 D11 case 5).
    await seed("absent");
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    // NO fixture teardown, deliberately (task-62 D6).
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

  /** Connect with the DISCOVERED installation id + login (never `"42"` / `"acme"`). */
  const connectGithub = (userId: string) =>
    seedGithubConnection(prisma, userId);

  /**
   * A Project row pointing at THIS RUN's real repo. `currentBranch` selects which of
   * the seeded fixture branches the read resolves to, so the branch IS the fixture.
   */
  async function makeProject(
    ownerId: string,
    opts: { currentBranch: string; repoName?: string; repoOwner?: string } = {
      currentBranch: "valid",
    },
  ): Promise<Project> {
    return prisma.project.create({
      data: {
        slug: `slug-${stamp()}`,
        ownerId,
        name: opts.repoName ?? fixture.repo,
        repoOwner: opts.repoOwner ?? fixture.owner,
        repoName: opts.repoName ?? fixture.repo,
        repoVisibility: "private",
        createdFrom: "blank",
        currentBranch: opts.currentBranch,
      },
    });
  }

  const api = (path: string, token?: string) =>
    fetch(`${baseUrl}/v1${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  // --------------------------------------------------------------- happy path

  it("returns the Zod-parsed manifest read from the project's working branch on real GitHub", async () => {
    const owner = await seedUser("ok");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "valid" });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Byte-exact round-trip through a real commit, real base64 transport (GitHub wraps
    // it with newlines) and a real Zod parse.
    expect(body.manifest).toEqual(VALID_MANIFEST);
  });

  it("honors an explicit ?ref= over the project's current branch, using REAL GitHub ref semantics", async () => {
    const owner = await seedUser("ref");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "valid" });

    // Both refs really exist and really hold different bytes, so this now exercises
    // GitHub's own `?ref=` resolution rather than a stub's keyed map.
    const working = await api(`/projects/${project.id}/manifest`, owner.token);
    expect((await working.json()).manifest).toEqual(VALID_MANIFEST);

    const res = await api(`/projects/${project.id}/manifest?ref=other`, owner.token);
    expect(res.status).toBe(200);
    expect((await res.json()).manifest).toEqual(OTHER_MANIFEST);
  });

  // ----------------------------------------------------- corrupted → typed 422

  it("returns a typed 422 for a manifest that is not valid JSON", async () => {
    const owner = await seedUser("badjson");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "badjson" });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("manifest_invalid");
  });

  it("returns a typed 422 for JSON that fails ProjectManifestSchema", async () => {
    const owner = await seedUser("badschema");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "badschema" });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("manifest_invalid");
  });

  // ------------------------------------------------------------- 404 / 409 / 401

  it("404s when the manifest file is absent on an EXISTING ref", async () => {
    const owner = await seedUser("missing");
    await connectGithub(owner.userId);
    // Branch `absent` exists (asserted at seed time) but carries no manifest, so this
    // is a real Contents 404 for the file — not for the ref.
    const project = await makeProject(owner.userId, { currentBranch: "absent" });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("manifest_not_found");
  });

  it("404s when the REF itself does not exist (a distinct real-GitHub 404 path)", async () => {
    const owner = await seedUser("badref");
    await connectGithub(owner.userId);
    const project = await makeProject(owner.userId, { currentBranch: "valid" });

    const res = await api(
      `/projects/${project.id}/manifest?ref=no-such-branch-${stamp()}`,
      owner.token,
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("manifest_not_found");
  });

  it("409s when the project owner has no GitHub connection — ZERO GitHub egress", async () => {
    // No fixture is seeded for this case on purpose: the 409 short-circuits in the api
    // before any GitHub call. The stub era seeded a manifest here that could never be
    // read, which obscured the fact that this path needs no provider at all.
    const owner = await seedUser("noconn");
    const project = await makeProject(owner.userId, { currentBranch: "valid" });

    const res = await api(`/projects/${project.id}/manifest`, owner.token);
    expect(res.status).toBe(409);
  });

  it("404s a cross-owner project (never 403) and 401s without a bearer token — pure authz, zero egress", async () => {
    const owner = await seedUser("owner");
    const other = await seedUser("other");
    await connectGithub(other.userId);
    const project = await makeProject(owner.userId, { currentBranch: "valid" });

    expect(
      (await api(`/projects/${project.id}/manifest`, other.token)).status,
    ).toBe(404);
    expect((await api(`/projects/${project.id}/manifest`)).status).toBe(401);
  });

});
