import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  createPrismaClient,
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  RENDER_QUEUE_NAME,
  RENDER_WORKFLOW_NAME,
  type PrismaClient,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { ProjectsService } from "../../src/projects/projects-service";
import { RendersService } from "../../src/renders/renders-service";
import { makeS3Client, type S3EnvConfig } from "../../src/files/s3-client";
import { FilesService } from "../../src/files/files-service";
import { makeDbosEnqueuer } from "../../src/jobs/enqueuer";

// Non-UI e2e for the Task #37 render surface (design-delta §2.7/§6c/§8). Boots the REAL
// Fastify app in-process (real listen + real fetch), a REAL DBOSClient enqueuer (its
// `cancel` seam → DBOSClient.cancelWorkflow), the REAL Compose MinIO, and a minimal
// in-process DBOS worker registering a STAND-IN workflow under the real shared name
// `render` on the real `render` queue at workerConcurrency 1.
//
// The stand-in drives exactly the RenderJob transitions the real worker drives —
// startedAt-while-still-queued (task 36's markRenderStarted), synthesizing → bundling
// (+framesTotal) → encoding (+monotonic framesDone) → uploading → completed with both
// asset keys — and uploads real bytes to MinIO, so the whole
// enqueue → dispatch → poll → download → cancel loop is proven inside the api repo.
// The REAL Remotion bundle/render behaviour is proven by the dbos repo's
// render.render.e2e.ts (task 36); duplicating a real render here would add ~10 minutes
// for zero new information.
//
// ZERO provider egress: the API render path makes no OpenRouter / Gloo / YouVersion /
// GitHub calls. Infra (postgres + minio + minio-init) via tests/e2e/global-setup.ts.
// Task 62 repointed every GitHub-touching api e2e at real github.com and retired the
// github-stub + git-server fixtures; this spec is UNAFFECTED because it never needed
// either, and it needs no GitHub credential for the same reason.
//
// Assumes the root Compose `dbos` container is NOT running (no competing render worker) —
// the same standing assumption ai-generations.e2e.ts and project-jobs.e2e.ts make.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const DBOS_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";
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

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma: PrismaClient = createPrismaClient({ connectionString: APP_URL });
let s3: S3Client;
const putKeys: string[] = [];

const OUTPUT_SPEC = {
  width: 320,
  height: 568,
  fps: 30,
  aspectRatio: "9:16",
  codec: "h264",
} as const;

/** Frames the stand-in "encodes" — small, so the happy path is a couple of seconds. */
const STAND_IN_FRAMES = 30;
/** The bytes the stand-in "uploads" as the render output, per render job id. */
const outputBytes = new Map<string, string>();

// ---- Barrier controller: park the stand-in worker at chosen phases. ----
let gateEncode: Promise<void> | null = null;
let releaseEncode: (() => void) | null = null;
function armEncodeGate(): void {
  gateEncode = new Promise<void>((r) => (releaseEncode = r));
}
function disarmEncodeGate(): void {
  gateEncode = null;
  releaseEncode?.();
  releaseEncode = null;
}

/**
 * Stands in for the real renderWorkflow: drives the SAME RenderJob row transitions,
 * keyed by workflowID = the render job id. Each phase is its own DBOS step so a
 * `cancelWorkflow` is preempted at a step boundary, exactly like the real workflow.
 */
async function standInRenderFn(_payload: unknown): Promise<{ ok: true }> {
  const id = DBOS.workflowID!;

  // task 36's markRenderStarted: sets startedAt WITHOUT changing status — the row stays
  // `queued` through the (here elided) clone / install / asset-download phase.
  await DBOS.runStep(
    async () => {
      await prisma.renderJob.updateMany({
        where: { id },
        data: { startedAt: new Date() },
      });
    },
    { name: "standInMarkStarted" },
  );

  await DBOS.runStep(
    async () => {
      await prisma.renderJob.updateMany({
        where: { id },
        data: { status: "synthesizing" },
      });
    },
    { name: "standInSynthesize" },
  );

  // bundleComposition is where framesTotal first becomes known (0 until then).
  await DBOS.runStep(
    async () => {
      await prisma.renderJob.updateMany({
        where: { id },
        data: { status: "bundling", framesTotal: STAND_IN_FRAMES },
      });
    },
    { name: "standInBundle" },
  );

  if (gateEncode) await gateEncode;

  await DBOS.runStep(
    async () => {
      await prisma.renderJob.updateMany({
        where: { id },
        data: { status: "encoding" },
      });
    },
    { name: "standInEncodeStart" },
  );

  // monotonic high-water frame progress, exactly like recordFrameProgress
  for (let n = 10; n <= STAND_IN_FRAMES; n += 10) {
    const at = n;
    await DBOS.runStep(
      async () => {
        await prisma.renderJob.updateMany({
          where: { id, framesDone: { lt: at } },
          data: { framesDone: at },
        });
      },
      { name: `standInProgress${at}` },
    );
  }

  await DBOS.runStep(
    async () => {
      await prisma.renderJob.updateMany({
        where: { id },
        data: { status: "uploading" },
      });
    },
    { name: "standInUpload" },
  );

  // upload REAL bytes so GET /renders/:id/download can round-trip them
  await DBOS.runStep(
    async () => {
      const key = buildRenderOutputKey(id);
      const body = outputBytes.get(id) ?? `render-bytes-${id}`;
      outputBytes.set(id, body);
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_CFG.bucket,
          Key: key,
          Body: body,
          ContentType: "video/mp4",
        }),
      );
      putKeys.push(key);
    },
    { name: "standInPutObject" },
  );

  await DBOS.runStep(
    async () => {
      await prisma.renderJob.updateMany({
        where: { id },
        data: {
          status: "completed",
          framesDone: STAND_IN_FRAMES,
          framesTotal: STAND_IN_FRAMES,
          outputAssetKey: buildRenderOutputKey(id),
          thumbnailAssetKey: buildRenderThumbnailKey(id),
          completedAt: new Date(),
          error: null,
        },
      });
    },
    { name: "standInMarkCompleted" },
  );

  return { ok: true };
}
DBOS.registerWorkflow(standInRenderFn, { name: RENDER_WORKFLOW_NAME });

let app: FastifyInstance;
let baseUrl: string;
let enqueuer: {
  enqueue: (o: any, p: unknown) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  close: () => Promise<void>;
};

beforeAll(async () => {
  s3 = makeS3Client(S3_CFG, "presign");
  await s3.send(new CreateBucketCommand({ Bucket: S3_CFG.bucket })).catch(() => {});

  DBOS.setConfig({ name: "supagloo-api-render-e2e", systemDatabaseUrl: DBOS_URL });
  await DBOS.launch();
  await DBOS.registerQueue(RENDER_QUEUE_NAME, { workerConcurrency: 1 });

  enqueuer = makeDbosEnqueuer({ systemDatabaseUrl: DBOS_URL });

  const authService = new AuthService({
    prisma,
    verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
    sessionTtlMs: SESSION_TTL_MS,
  });
  const projectsService = new ProjectsService({ prisma });
  const filesService = new FilesService({ prisma, s3, bucket: S3_CFG.bucket });
  const rendersService = new RendersService({
    prisma,
    enqueue: enqueuer.enqueue,
    cancel: enqueuer.cancel,
    presignDownload: (userId, key) => filesService.presignDownload(userId, key),
  });

  app = buildApp({
    auth: {
      authService,
      env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
    },
    projects: { service: projectsService },
    files: { service: filesService },
    renders: { service: rendersService },
  });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);

afterAll(async () => {
  disarmEncodeGate();
  for (const key of putKeys) {
    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_CFG.bucket, Key: key }))
      .catch(() => {});
  }
  if (app) await app.close();
  await enqueuer?.close().catch(() => {});
  await DBOS.shutdown();
  if (s3) s3.destroy();
  await prisma.$disconnect().catch(() => {});
});

// ------------------------------------------------------------------- helpers

async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
  const s = stamp();
  const token = `render-e2e-${tag}-${s}`;
  const res = await fetch(`${baseUrl}/v1/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      users: [
        {
          youversionUserId: `yv-render-${tag}-${s}`,
          displayName: `Render E2E ${tag}`,
          email: `render-${tag}-${s}@example.test`,
          avatarInitials: "RE",
          sessionToken: token,
        },
      ],
    }),
  });
  const body = await res.json();
  return { token, userId: body.users[0].user.id };
}

async function seedProject(
  userId: string,
  tag: string,
): Promise<{ projectId: string; versionId: string }> {
  const s = stamp();
  const project = await prisma.project.create({
    data: {
      slug: `render-${tag}-${s}`,
      ownerId: userId,
      name: `Render Project ${tag}`,
      repoOwner: "ashtable",
      repoName: `render-${tag}-${s}`,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
    },
  });
  const version = await prisma.projectVersion.create({
    data: {
      projectId: project.id,
      semver: "0.0.1",
      branchName: "v0.0.1",
      state: "published",
      headCommitSha: "0".repeat(40),
      changedFiles: [],
    },
  });
  return { projectId: project.id, versionId: version.id };
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
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

function createBody(versionId: string, over: Record<string, unknown> = {}) {
  return { versionId, outputSpec: { ...OUTPUT_SPEC }, runInBackground: false, ...over };
}

async function startRender(
  token: string,
  projectId: string,
  versionId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await api(`/projects/${projectId}/renders`, token, {
    method: "POST",
    body: createBody(versionId, over),
  });
  expect(res.status).toBe(201);
  return (await res.json()).renderJobId;
}

async function getRender(token: string, id: string) {
  const res = await api(`/renders/${id}`, token);
  expect(res.status).toBe(200);
  return (await res.json()).render;
}

async function pollUntilStatus(
  token: string,
  id: string,
  status: string,
  timeoutMs = 25_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await getRender(token, id);
    if (last.status === status) return last;
    await sleep(120);
  }
  throw new Error(
    `render ${id} did not reach ${status} within ${timeoutMs}ms (last=${last?.status})`,
  );
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(120);
  }
  throw new Error("waitFor timed out");
}

// ---------------------------------------------------------------------- specs

describe("e2e: render creation + durable enqueue", () => {
  it("E-R1: POST /projects/:id/renders creates a queued row, mirrors the spec, sets Project.lastRenderJobId, and durably enqueues under workflowID = renderJobId", async () => {
    armEncodeGate();
    const user = await seedUser("create");
    const { projectId, versionId } = await seedProject(user.userId, "create");

    const renderJobId = await startRender(user.token, projectId, versionId, {
      runInBackground: true,
    });
    expect(typeof renderJobId).toBe("string");

    const row = await prisma.renderJob.findUnique({ where: { id: renderJobId } });
    expect(row).not.toBeNull();
    expect(row!.projectId).toBe(projectId);
    expect(row!.versionId).toBe(versionId);
    expect(row!.userId).toBe(user.userId);
    expect(row!.width).toBe(OUTPUT_SPEC.width);
    expect(row!.height).toBe(OUTPUT_SPEC.height);
    expect(row!.fps).toBe(OUTPUT_SPEC.fps);
    expect(row!.aspectRatio).toBe(OUTPUT_SPEC.aspectRatio);
    expect(row!.codec).toBe(OUTPUT_SPEC.codec);
    // stored as a UI hint only
    expect(row!.runInBackground).toBe(true);
    // D1 — the API does not estimate; the worker writes the real total at bundle time
    expect(row!.framesDone).toBe(0);

    // D3 — the project points at its latest render job
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project!.lastRenderJobId).toBe(renderJobId);

    // durably enqueued under the render job id
    await waitFor(async () => {
      const wfs = await DBOS.listWorkflows({ workflowIDs: [renderJobId] });
      return wfs.length === 1;
    }, 20_000);

    disarmEncodeGate();
    await pollUntilStatus(user.token, renderJobId, "completed");
  }, 60_000);
});

describe("e2e: the render happy path", () => {
  it("E-R2: progress is monotonic, framesTotal appears at bundle time, and the job reaches completed", async () => {
    const user = await seedUser("happy");
    const { projectId, versionId } = await seedProject(user.userId, "happy");
    const renderJobId = await startRender(user.token, projectId, versionId);

    let lastFrames = -1;
    let sawTotal = false;
    const deadline = Date.now() + 25_000;
    let dto: any;
    while (Date.now() < deadline) {
      dto = await getRender(user.token, renderJobId);
      expect(dto.framesDone).toBeGreaterThanOrEqual(lastFrames); // never rewinds
      lastFrames = dto.framesDone;
      if (dto.framesTotal > 0) sawTotal = true;
      if (dto.status === "completed") break;
      await sleep(100);
    }

    expect(dto.status).toBe("completed");
    expect(sawTotal).toBe(true);
    expect(dto.framesDone).toBe(dto.framesTotal);
    expect(dto.outputAssetKey).toBe(buildRenderOutputKey(renderJobId));
    expect(dto.thumbnailAssetKey).toBe(buildRenderThumbnailKey(renderJobId));
    expect(dto.completedAt).not.toBeNull();
    expect(dto.error).toBeNull();
    // the wire DTO re-nests the five spec columns
    expect(dto.outputSpec).toEqual(OUTPUT_SPEC);
  }, 60_000);
});

describe("e2e: presigned download", () => {
  it("E-R3: GET /renders/:id/download presigns against the PUBLIC endpoint and round-trips the bytes", async () => {
    const user = await seedUser("dl");
    const { projectId, versionId } = await seedProject(user.userId, "dl");
    const renderJobId = await startRender(user.token, projectId, versionId);
    await pollUntilStatus(user.token, renderJobId, "completed");

    const res = await api(`/renders/${renderJobId}/download`, user.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new URL(body.url).host).toBe("localhost:9000");
    expect(body.url).toContain("X-Amz-Signature");
    expect(typeof body.expiresAt).toBe("string");

    const fetched = await fetch(body.url);
    expect(fetched.ok).toBe(true);
    expect(await fetched.text()).toBe(outputBytes.get(renderJobId));
  }, 60_000);

  it("E-R4: download 404s while not completed, 404s cross-user, and 401s unauthenticated", async () => {
    armEncodeGate();
    const owner = await seedUser("dl-owner");
    const other = await seedUser("dl-other");
    const { projectId, versionId } = await seedProject(owner.userId, "dl-gate");
    const renderJobId = await startRender(owner.token, projectId, versionId);

    // parked before encoding — output does not exist yet
    const notReady = await api(`/renders/${renderJobId}/download`, owner.token);
    expect(notReady.status).toBe(404);

    disarmEncodeGate();
    await pollUntilStatus(owner.token, renderJobId, "completed");

    const foreign = await api(`/renders/${renderJobId}/download`, other.token);
    expect(foreign.status).toBe(404);
    const anon = await api(`/renders/${renderJobId}/download`);
    expect(anon.status).toBe(401);

    // a foreign render is equally invisible on the read + cancel routes
    expect((await api(`/renders/${renderJobId}`, other.token)).status).toBe(404);
    expect(
      (await api(`/renders/${renderJobId}/cancel`, other.token, { method: "POST" }))
        .status,
    ).toBe(404);
  }, 60_000);
});

describe("e2e: cancel", () => {
  it("E-R5: cancel mid-flight flips the row to canceled, cancels the DBOS workflow, and re-cancel 409s", async () => {
    armEncodeGate();
    const user = await seedUser("cancel");
    const { projectId, versionId } = await seedProject(user.userId, "cancel");
    const renderJobId = await startRender(user.token, projectId, versionId);

    // parked at the encode gate — the workflow is live and non-terminal
    await pollUntilStatus(user.token, renderJobId, "bundling");

    const res = await api(`/renders/${renderJobId}/cancel`, user.token, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).render.status).toBe("canceled");

    // the DBOS workflow itself is cancelled (note DBOS spells it CANCELLED)
    await waitFor(async () => {
      const wfs = await DBOS.listWorkflows({ workflowIDs: [renderJobId] });
      return wfs[0]?.status === "CANCELLED";
    }, 20_000);

    const again = await api(`/renders/${renderJobId}/cancel`, user.token, {
      method: "POST",
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("render_not_cancelable");

    const unknown = await api(`/renders/no-such-render/cancel`, user.token, {
      method: "POST",
    });
    expect(unknown.status).toBe(404);

    disarmEncodeGate();
  }, 60_000);
});

describe("e2e: ?mine=1 scoping", () => {
  it("E-R6: returns ONLY the caller's renders, newest first; a bare GET /renders 400s; anonymous 401s", async () => {
    const a = await seedUser("mine-a");
    const b = await seedUser("mine-b");
    const pa = await seedProject(a.userId, "mine-a");
    const pb = await seedProject(b.userId, "mine-b");

    const a1 = await startRender(a.token, pa.projectId, pa.versionId);
    await pollUntilStatus(a.token, a1, "completed");
    const a2 = await startRender(a.token, pa.projectId, pa.versionId);
    await pollUntilStatus(a.token, a2, "completed");
    const b1 = await startRender(b.token, pb.projectId, pb.versionId);
    await pollUntilStatus(b.token, b1, "completed");

    const res = await api("/renders?mine=1", a.token);
    expect(res.status).toBe(200);
    const ids: string[] = (await res.json()).renders.map((r: any) => r.id);
    expect(ids).toContain(a1);
    expect(ids).toContain(a2);
    expect(ids).not.toContain(b1); // B's work never leaks into A's list
    // newest first
    expect(ids.indexOf(a2)).toBeLessThan(ids.indexOf(a1));

    expect((await api("/renders", a.token)).status).toBe(400);
    expect((await api("/renders?mine=1")).status).toBe(401);
  }, 90_000);
});

describe("e2e: create validation", () => {
  it("E-R7: a foreign project, a foreign version, and a malformed outputSpec are all rejected with no row created", async () => {
    const owner = await seedUser("val-owner");
    const other = await seedUser("val-other");
    const mine = await seedProject(owner.userId, "val-mine");
    const theirs = await seedProject(other.userId, "val-theirs");

    const before = await prisma.renderJob.count({ where: { projectId: mine.projectId } });

    // foreign project → 404
    const foreignProject = await api(
      `/projects/${theirs.projectId}/renders`,
      owner.token,
      { method: "POST", body: createBody(theirs.versionId) },
    );
    expect(foreignProject.status).toBe(404);

    // a version from ANOTHER project → 404 (uniform denial)
    const foreignVersion = await api(
      `/projects/${mine.projectId}/renders`,
      owner.token,
      { method: "POST", body: createBody(theirs.versionId) },
    );
    expect(foreignVersion.status).toBe(404);

    // malformed specs → 400 at the Zod boundary
    for (const bad of [
      { ...OUTPUT_SPEC, aspectRatio: "9-16" },
      { ...OUTPUT_SPEC, fps: 29.97 },
      { width: 320, height: 568, fps: 30, aspectRatio: "9:16" }, // no codec
      { ...OUTPUT_SPEC, width: 0 },
    ]) {
      const res = await api(`/projects/${mine.projectId}/renders`, owner.token, {
        method: "POST",
        body: { versionId: mine.versionId, outputSpec: bad, runInBackground: false },
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    const after = await prisma.renderJob.count({ where: { projectId: mine.projectId } });
    expect(after).toBe(before);
  }, 60_000);
});
