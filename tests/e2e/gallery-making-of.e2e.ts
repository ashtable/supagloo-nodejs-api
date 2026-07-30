import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  createPrismaClient,
  GalleryMakingOfSchema,
  type PrismaClient,
  type ProjectManifest,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import {
  makeYouVersionVerifier,
  youVersionEndpointsFrom,
} from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { makeS3Client, type S3EnvConfig } from "../../src/files/s3-client";
import { FilesService } from "../../src/files/files-service";
import { ProjectsService } from "../../src/projects/projects-service";
import { ManifestService } from "../../src/manifests/manifest-service";
import { GalleryService } from "../../src/gallery/gallery-service";
import { makeGithubAppClient } from "../../src/connections/github-app-client";
import {
  githubApiBaseUrl,
  loadRootE2eHarness,
  mintE2eInstallationToken,
  provisionFixtureRepo,
  resolveGithubE2eContext,
  seedGithubConnection,
  seedRepoFileOnBranch,
  type FixtureRepo,
} from "../../src/testing/github-e2e";

// Non-UI e2e for the Turn-16a "making of" snapshot (plan slice C3) — the REAL-GITHUB
// half. Boots the REAL Fastify app in-process against REAL Compose Postgres and
// **real api.github.com**, and publishes through the REAL
// `POST /v1/renders/:id/gallery`, whose best-effort manifest read goes out over real
// HTTPS to GitHub's Contents API.
//
// WHY THIS FILE EXISTS AT ALL — it is a deliberate SPLIT, not a duplicate.
// `tests/e2e/gallery.e2e.ts` is a ZERO-EGRESS, ZERO-CREDENTIAL spec, and it must stay
// that way (the 34-E8 lesson: coupling a gallery spec to GitHub credentials makes the
// whole gallery surface unrunnable without a GitHub App). It therefore owns the
// best-effort NULL branch (E-G22), which reaches no socket because its fixtures have no
// `GithubConnection`. The HAPPY path cannot be proven that way — a manifest that is
// never read is not a manifest that was read correctly — so it lives here, on task-62's
// fixture-repo harness, exactly as `manifest.e2e.ts` does.
//
// THE FIXTURE BRANCHES (one throwaway repo per run, `auto_init: true`, four real
// branches cut from `main` with the INSTALLATION token):
//
//   branch `valid`     — a real, schema-valid manifest, 3 scenes    (E-MO1)
//   branch `other`     — a DIFFERENT valid manifest                 (E-MO4: the ref matters)
//   branch `mutable`   — starts as `valid`'s manifest, then CHANGES (E-MO2)
//   branch `badschema` — valid JSON that fails ProjectManifestSchema (E-MO3)
//
// NO MinIO. Publish never touches S3, and the poster/stream URLs are signed OFFLINE by
// `getSignedUrl`, so this spec asserts nothing that requires an object to exist. Saying
// so is the point: the fewer real dependencies a spec claims, the more its failures mean.
//
// DURABLE SIDE EFFECTS: one private throwaway repo per run, NEVER auto-removed
// (task-62 D6). Reclaim with the root repo's `npm run cleanup:github-e2e`.
//
// AND THE ONE THAT IS NOT OPTIONAL — this spec WRITES TO A GLOBAL SURFACE. Every item it
// publishes is a `visibility='public'` row that `GET /v1/gallery` shows to everyone,
// including the nextjs UI spec whose `beforeAll` refuses to run when foreign public items
// exist. A previous leak of ~47 rows per run took 21 UI tests down with a message that
// read like the developer's own database was dirty. So `afterAll` deletes every row this
// file caused to exist, BY TRACKED ID (`id: { in: [...] }`) and never by an id pattern —
// a pattern would eventually match somebody else's row.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";

const S3_CFG: S3EnvConfig = {
  internalEndpoint: process.env.S3_ENDPOINT ?? "http://minio:9000",
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  bucket: process.env.S3_BUCKET ?? "supagloo-dev",
  accessKey: process.env.S3_ACCESS_KEY ?? "supagloo",
  secretKey: process.env.S3_SECRET_KEY ?? "supagloo-dev",
};

const MANIFEST_PATH = "supagloo.project.json";
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function manifestWith(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    manifestVersion: 1,
    composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
    scenes: [
      {
        id: "sc-1",
        name: "The Shelter",
        scriptText: "He who dwells in the shelter of the Most High",
        reference: "Psalm 91:1",
        translation: "BSB",
        visualPrompt: "a wide desert at dawn",
        durationSeconds: 4,
        captions: true,
      },
      {
        id: "sc-2",
        name: "His Feathers",
        scriptText: "will rest in the shadow of the Almighty.",
        reference: "Psalm 91:1",
        translation: "BSB",
        visualPrompt: "wings over a valley",
        // FRACTIONAL on purpose: the manifest's own `durationSeconds` is
        // `z.number().positive()`, and a builder that rounded would lose this.
        durationSeconds: 6.5,
        captions: true,
      },
      {
        id: "sc-3",
        name: "No Fear",
        scriptText: "You will not fear the terror of night.",
        reference: "Psalm 91:5",
        translation: "BSB",
        visualPrompt: "night sky over a still lake",
        durationSeconds: 5,
        captions: true,
      },
    ],
    narratorVoice: {
      description: "A calm, measured, unhurried narrator",
      label: "LOW AND STEADY",
    },
    music: { style: "Ambient strings, slow build" },
    ...over,
  };
}

/** What `buildMakingOfSnapshot` must produce from {@link manifestWith}'s default. */
const EXPECTED_SCRIPTURE =
  "He who dwells in the shelter of the Most High " +
  "will rest in the shadow of the Almighty. " +
  "You will not fear the terror of night.";
const EXPECTED_SCENES = [
  { index: 1, name: "The Shelter", durationSeconds: 4 },
  { index: 2, name: "His Feathers", durationSeconds: 6.5 },
  { index: 3, name: "No Fear", durationSeconds: 5 },
];

/** The `other` branch's manifest — deliberately different in EVERY snapshot field, so
 *  E-MO4 cannot pass by reading the wrong branch and matching by accident. */
const OTHER_MANIFEST = manifestWith({
  scenes: [
    {
      id: "o-1",
      name: "A Different Scene",
      scriptText: "Sing to the LORD a new song.",
      reference: "Psalm 96:1",
      translation: "KJV",
      visualPrompt: "sunrise over a city",
      durationSeconds: 9,
      // MIXED captions, so `captionsOn` differs too and the aggregation rule survives a
      // real JSON round trip rather than only a unit fixture.
      captions: false,
    },
  ],
  narratorVoice: { description: "Bright and quick", label: "BRIGHT" },
  music: { style: "Solo piano" },
});

/** The `mutable` branch's SECOND manifest — pushed AFTER the publish, so E-MO2 can prove
 *  the stored snapshot is not recomputed from today's repo. */
const MUTATED_MANIFEST = manifestWith({
  scenes: [
    {
      id: "m-1",
      name: "Edited After Publishing",
      scriptText: "This text was committed after the video was published.",
      reference: "Psalm 91:1",
      translation: "BSB",
      visualPrompt: "an empty room",
      durationSeconds: 3,
      captions: false,
    },
  ],
  narratorVoice: { description: "Edited later", label: "EDITED LATER" },
  music: { style: "Edited later" },
});

const prisma: PrismaClient = createPrismaClient({ connectionString: APP_URL });

/** EVERY row this spec causes to exist, so `afterAll` deletes exactly its own. Gallery
 *  items are tracked BY ID because they are the rows that are globally visible. */
const createdGalleryItemIds: string[] = [];
const createdRenderIds: string[] = [];
const createdVersionIds: string[] = [];
const createdProjectIds: string[] = [];
const createdUserIds: string[] = [];

let app: FastifyInstance;
let baseUrl: string;
let fixture: FixtureRepo;

describe("e2e: the making-of snapshot (real github.com Contents API)", () => {
  beforeAll(async () => {
    // Fail FAST + LOUD (never warn-and-skip) on a missing credential or an uninstalled
    // App — see src/testing/github-e2e.ts for the remediation text.
    const ctx = await resolveGithubE2eContext();

    const authService = new AuthService({
      prisma,
      verifyToken: makeYouVersionVerifier(youVersionEndpointsFrom(YOUVERSION_BASE)),
      sessionTtlMs: SESSION_TTL_MS,
    });
    const s3 = makeS3Client(S3_CFG, "presign");
    const filesService = new FilesService({
      prisma,
      s3,
      bucket: S3_CFG.bucket,
    });
    const projectsService = new ProjectsService({ prisma });
    const githubAppClient = makeGithubAppClient({
      apiBaseUrl: githubApiBaseUrl(),
      appId: ctx.appId,
      privateKey: ctx.privateKey,
    });
    // The PRODUCT wiring, verbatim from `server.ts`: the gallery's snapshot seam is the
    // real ManifestService over the real GitHub App client. Nothing here is a stand-in,
    // which is what makes a green run mean the shipped path works.
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
      files: { service: filesService },
      gallery: {
        service: new GalleryService({
          prisma,
          presignPublic: (key, ttl) => filesService.presignPublicKey(key, ttl),
          readManifestForSnapshot: (userId, projectId) =>
            manifestService.readManifest(userId, projectId),
        }),
      },
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

    // ONE repo for every case (task-62 D7: repo creation is governed by GitHub's
    // secondary/abuse limits, so the per-run creation budget is deliberately minimal).
    fixture = await provisionFixtureRepo("gallery-making-of", {
      spec: "supagloo-nodejs-api/tests/e2e/gallery-making-of.e2e.ts",
    });

    // Seeding uses the INSTALLATION token, not the PAT (task-62 D6): it exercises the
    // installation's granted `contents:write` for real.
    const token = await mintE2eInstallationToken();
    const seed = (branch: string, content: string) =>
      seedRepoFileOnBranch({
        owner: fixture.owner,
        repo: fixture.repo,
        branch,
        token,
        fromBranch: fixture.defaultBranch,
        path: MANIFEST_PATH,
        content,
      });

    await seed("valid", JSON.stringify(manifestWith()));
    await seed("other", JSON.stringify(OTHER_MANIFEST));
    await seed("mutable", JSON.stringify(manifestWith()));
    await seed(
      "badschema",
      JSON.stringify({ ...manifestWith(), manifestVersion: 2 }),
    );
  });

  /** Teardown that never aborts: a partial delete leaves exactly the state — public
   *  `GalleryItem` rows with no owner story — that trips the next reader of the global
   *  listing, so every step reports and continues. */
  async function teardownStep(what: string, run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      console.error(`[gallery-making-of.e2e teardown] ${what} FAILED:`, error);
    }
  }

  afterAll(async () => {
    // BY TRACKED ID. Never `LIKE`: this suite must not be able to delete data it did
    // not create.
    await teardownStep("galleryItem", () =>
      prisma.galleryItem.deleteMany({
        where: { id: { in: createdGalleryItemIds } },
      }),
    );
    await teardownStep("renderJob", () =>
      prisma.renderJob.deleteMany({ where: { id: { in: createdRenderIds } } }),
    );
    await teardownStep("projectVersion", () =>
      prisma.projectVersion.deleteMany({
        where: { id: { in: createdVersionIds } },
      }),
    );
    await teardownStep("project", () =>
      prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }),
    );
    await teardownStep("githubConnection", () =>
      prisma.githubConnection.deleteMany({
        where: { userId: { in: createdUserIds } },
      }),
    );
    await teardownStep("session", () =>
      prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }),
    );
    await teardownStep("user", () =>
      prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }),
    );

    if (app) await app.close();
    await prisma.$disconnect().catch(() => {});
    // NO fixture-repo teardown, deliberately (task-62 D6).
  });

  // ------------------------------------------------------------------- helpers

  async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
    const s = stamp();
    const token = `gallery-mo-e2e-${tag}-${s}`;
    const res = await fetch(`${baseUrl}/v1/test/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        users: [
          {
            youversionUserId: `yv-gallery-mo-${tag}-${s}`,
            displayName: `Gallery MakingOf E2E ${tag}`,
            email: `gallery-mo-${tag}-${s}@example.test`,
            avatarInitials: "GM",
            sessionToken: token,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const userId = body.users[0].user.id;
    createdUserIds.push(userId);
    return { token, userId };
  }

  /** A project pointing at THIS RUN's real repo; `currentBranch` selects the fixture. */
  async function seedProject(ownerId: string, tag: string, branch: string) {
    const s = stamp();
    const project = await prisma.project.create({
      data: {
        slug: `gallery-mo-${tag}-${s}`,
        ownerId,
        name: fixture.repo,
        repoOwner: fixture.owner,
        repoName: fixture.repo,
        repoVisibility: "private",
        createdFrom: "blank",
        currentBranch: branch,
      },
    });
    const version = await prisma.projectVersion.create({
      data: {
        projectId: project.id,
        semver: "0.0.1",
        branchName: branch,
        state: "working",
        headCommitSha: "0".repeat(40),
        changedFiles: [],
      },
    });
    createdProjectIds.push(project.id);
    createdVersionIds.push(version.id);
    return { projectId: project.id, versionId: version.id };
  }

  /**
   * A `completed`, publishable RenderJob. NO S3 objects are written: publish reads none,
   * and the DTO's poster URL is signed offline. Nothing in this file fetches either URL.
   */
  async function seedCompletedRender(
    userId: string,
    project: { projectId: string; versionId: string },
    tag: string,
  ): Promise<string> {
    const id = `gal-mo-e2e-${tag}-${stamp()}`;
    createdRenderIds.push(id);
    await prisma.renderJob.create({
      data: {
        id,
        projectId: project.projectId,
        versionId: project.versionId,
        userId,
        status: "completed",
        framesDone: 900,
        framesTotal: 900,
        width: 320,
        height: 568,
        fps: 30,
        aspectRatio: "9:16",
        codec: "h264",
        outputAssetKey: buildRenderOutputKey(id),
        thumbnailAssetKey: buildRenderThumbnailKey(id),
        runInBackground: false,
        completedAt: new Date(),
      },
    });
    return id;
  }

  const api = (
    path: string,
    token?: string,
    init: { method?: string; body?: unknown } = {},
  ) =>
    fetch(`${baseUrl}/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  /** Publish through the REAL route and register the id for teardown IMMEDIATELY — the
   *  push happens before any assertion, so a failing expectation still cleans up. */
  async function publishOk(token: string, renderJobId: string, title: string) {
    const res = await api(`/renders/${renderJobId}/gallery`, token, {
      method: "POST",
      body: {
        title,
        description: "",
        scriptureReference: "Psalm 91:1",
        translation: "BSB",
        visibility: "public",
      },
    });
    const body = await res.clone().json().catch(() => null);
    if (body?.item?.id) createdGalleryItemIds.push(body.item.id);
    expect(res.status, await res.text()).toBe(201);
    return body.item;
  }

  const readDetail = async (id: string) => {
    const res = await api(`/gallery/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()).item;
  };

  /** One publishable, GitHub-connected owner whose project points at `branch`. */
  async function setup(tag: string, branch: string) {
    const user = await seedUser(tag);
    await seedGithubConnection(prisma, user.userId);
    const project = await seedProject(user.userId, tag, branch);
    const render = await seedCompletedRender(user.userId, project, tag);
    return { user, project, render };
  }

  // ------------------------------------------------------------------ the cases

  it("E-MO1: publishing a render whose repo carries a real, valid manifest persists a makingOf snapshot, and GET /v1/gallery/:id returns it", async () => {
    const { user, render } = await setup("ok", "valid");

    const before = Date.now();
    const item = await publishOk(user.token, render, `Making of ${stamp()}`);
    const after = Date.now();

    const detail = await readDetail(item.id);
    const snap = detail.makingOf;
    expect(snap, "expected a snapshot after a real, valid manifest read").not.toBeNull();

    // Every field the watch page draws, against the manifest that was really committed
    // and really read back over HTTPS.
    expect(snap.version).toBe(1);
    expect(snap.scriptureText).toBe(EXPECTED_SCRIPTURE);
    expect(snap.scenes).toEqual(EXPECTED_SCENES);
    expect(snap.captionsOn).toBe(true);
    expect(snap.narratorVoiceLabel).toBe("LOW AND STEADY");
    expect(snap.musicStyle).toBe("Ambient strings, slow build");

    // `capturedAt` is the PUBLISH instant, not the read instant and not "some ISO
    // string": it is what tells a future reader how stale the section is.
    const captured = Date.parse(snap.capturedAt);
    expect(Number.isFinite(captured)).toBe(true);
    expect(captured).toBeGreaterThanOrEqual(before - 1000);
    expect(captured).toBeLessThanOrEqual(after + 1000);

    // What was stored survives the column's own validator — i.e. the row is readable by
    // any future consumer, not merely by today's serializer.
    expect(GalleryMakingOfSchema.safeParse(snap).success).toBe(true);
  }, 180_000);

  it("E-MO2: the snapshot is PERSISTED, not recomputed — editing the repo after publishing does not change it", async () => {
    const { user, render } = await setup("persisted", "mutable");

    const item = await publishOk(user.token, render, `Persisted ${stamp()}`);
    const first = await readDetail(item.id);
    expect(first.makingOf.scriptureText).toBe(EXPECTED_SCRIPTURE);

    // A REAL commit to the branch this project points at, after the publish. A watch
    // page that re-read the manifest would now show text that was written AFTER the
    // video was rendered — the subtler of the two lies the snapshot design exists to
    // prevent — and it would need an installation token on a public, anonymous route.
    const harness = await loadRootE2eHarness();
    await harness.api.putContents({
      token: await mintE2eInstallationToken(),
      owner: fixture.owner,
      repo: fixture.repo,
      branch: "mutable",
      path: MANIFEST_PATH,
      content: JSON.stringify(MUTATED_MANIFEST),
    });

    const second = await readDetail(item.id);
    const third = await readDetail(item.id);

    expect(second.makingOf).toEqual(first.makingOf);
    expect(third.makingOf).toEqual(first.makingOf);
    expect(second.makingOf.scriptureText).not.toContain(
      "committed after the video was published",
    );
  }, 180_000);

  it("E-MO3: a project whose branch carries a CORRUPT manifest still publishes 201, with makingOf: null", async () => {
    const { user, render } = await setup("corrupt", "badschema");

    // A REAL failure against a REAL repo: `manifestVersion: 2` is valid JSON that fails
    // `ProjectManifestSchema`, so `readManifest` raises `ManifestInvalidError` — the
    // same 422 the manifest ROUTE returns. Best effort means it is not an error HERE.
    const item = await publishOk(user.token, render, `Corrupt ${stamp()}`);
    const detail = await readDetail(item.id);

    expect(detail).toHaveProperty("makingOf", null);
    // ...and the publish is otherwise entirely normal.
    expect(detail.title).toBe(item.title);
    expect(detail.durationSeconds).toBe(30);
  }, 180_000);

  it("E-MO4: the snapshot comes from the project's CURRENT BRANCH, not from the repo default", async () => {
    // Two projects on ONE repo, differing only in `currentBranch`. If the read ignored
    // the branch (and read `main`, which carries no manifest at all), BOTH would be
    // null; if it read the wrong one, the fields below would cross over.
    const a = await setup("branch-valid", "valid");
    const b = await setup("branch-other", "other");

    const itemA = await publishOk(a.user.token, a.render, `Branch A ${stamp()}`);
    const itemB = await publishOk(b.user.token, b.render, `Branch B ${stamp()}`);

    const snapA = (await readDetail(itemA.id)).makingOf;
    const snapB = (await readDetail(itemB.id)).makingOf;

    expect(snapA.narratorVoiceLabel).toBe("LOW AND STEADY");
    expect(snapA.musicStyle).toBe("Ambient strings, slow build");
    expect(snapA.captionsOn).toBe(true);
    expect(snapA.scenes).toEqual(EXPECTED_SCENES);

    expect(snapB.narratorVoiceLabel).toBe("BRIGHT");
    expect(snapB.musicStyle).toBe("Solo piano");
    // The `other` manifest's single scene has captions OFF, so the aggregation rule
    // survives a real JSON round trip rather than only a unit fixture.
    expect(snapB.captionsOn).toBe(false);
    expect(snapB.scenes).toEqual([
      { index: 1, name: "A Different Scene", durationSeconds: 9 },
    ]);
    expect(snapB.scriptureText).toBe("Sing to the LORD a new song.");
  }, 180_000);

  it("E-MO5: a project whose branch has NO manifest publishes 201 with makingOf: null — a real GitHub 404 is best-effort too", async () => {
    // `main` is created by `auto_init: true` and carries only the repo's README, so the
    // Contents read is a REAL 404 for the file on an EXISTING ref (not for the ref).
    const { user, render } = await setup("nofile", fixture.defaultBranch);

    const item = await publishOk(user.token, render, `No manifest ${stamp()}`);
    expect(await readDetail(item.id)).toHaveProperty("makingOf", null);
  }, 180_000);
});
