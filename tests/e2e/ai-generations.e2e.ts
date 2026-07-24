import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  createPrismaClient,
  type PrismaClient,
  buildAssetKey,
  GENERATE_AUDIO_WORKFLOW_NAME,
  GENERATE_IMAGE_WORKFLOW_NAME,
  GENERATE_SCRIPT_WORKFLOW_NAME,
  GENERATE_VIDEO_WORKFLOW_NAME,
  AI_GENERATION_QUEUE_NAME,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { ProjectsService } from "../../src/projects/projects-service";
import { AiGenerationsService } from "../../src/ai/ai-generations-service";
import { makeDbosEnqueuer } from "../../src/jobs/enqueuer";

// Non-UI e2e for the Task #31 AI-generation surface (design-delta §2.8/§7/§8). Boots the
// REAL Fastify app in-process (real listen + fetch), a REAL DBOSClient enqueuer (its
// `cancel` seam → DBOSClient.cancelWorkflow), AND a minimal in-process DBOS worker
// registering a STAND-IN `generateScript` on the ai-generation queue. The stand-in flips
// the AiGeneration row queued→running→succeeded (barrier-gated) and writes a resultJson,
// so the whole enqueue→dispatch→execute→poll→cancel loop is proven within the api repo.
// The REAL generateScript workflow's LLM/repair behaviour is proven separately by the
// dbos repo's generate-script.e2e.ts. In-process per the in-flight-dblib constraint.
// Assumes the root Compose `dbos` container is NOT running (no competing ai-generation
// worker) — the same assumption project-jobs.e2e.ts makes. Infra via global-setup.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const DBOS_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";
const YOUVERSION_BASE =
  process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma: PrismaClient = createPrismaClient({ connectionString: APP_URL });

// ---- Barrier controller: park the stand-in worker at chosen phases. ----
let gateA: Promise<void> | null = null;
let releaseA: (() => void) | null = null;
let gateB: Promise<void> | null = null;
let releaseB: (() => void) | null = null;
function armGates(): void {
  gateA = new Promise<void>((r) => (releaseA = r));
  gateB = new Promise<void>((r) => (releaseB = r));
}
function disarmGates(): void {
  gateA = null;
  gateB = null;
}

const STUB_RESULT = {
  scriptText: "I lift up my eyes to the hills.",
  reference: "Psalm 121:1",
  translation: "KJV",
};
const STUB_USAGE = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };

// Stands in for the real generateScript: drives the SAME AiGeneration row transitions the
// real workflow drives (running → succeeded + resultJson), keyed by workflowID = the
// generation id. `updateMany` no-ops when no row matches.
async function standInGenerateScriptFn(_payload: unknown): Promise<{ ok: true }> {
  const genId = DBOS.workflowID!;
  if (gateA) await gateA;
  await DBOS.runStep(
    async () => {
      await prisma.aiGeneration.updateMany({
        where: { id: genId },
        data: { status: "running" },
      });
    },
    { name: "standInMarkRunning" },
  );
  if (gateB) await gateB;
  await DBOS.runStep(
    async () => {
      await prisma.aiGeneration.updateMany({
        where: { id: genId },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          resultJson: STUB_RESULT as any,
          tokenUsage: STUB_USAGE as any,
        },
      });
    },
    { name: "standInFinalize" },
  );
  return { ok: true };
}
DBOS.registerWorkflow(standInGenerateScriptFn, {
  name: GENERATE_SCRIPT_WORKFLOW_NAME,
});

// Task #32: a STAND-IN generateImage — drives the SAME AiGeneration row transitions the
// real image workflow drives (running → succeeded + resultAssetKey), keyed by
// workflowID = generationId. The REAL workflow's provider/S3 behaviour is proven by the
// dbos repo's generate-image.e2e.ts; here we only prove the API wires image (POST no
// longer 501s) and surfaces resultAssetKey on the DTO.
async function standInGenerateImageFn(_payload: unknown): Promise<{ ok: true }> {
  const genId = DBOS.workflowID!;
  await DBOS.runStep(
    async () => {
      const row = await prisma.aiGeneration.findUnique({ where: { id: genId } });
      const assetKey = row?.projectId ? buildAssetKey(row.projectId, genId) : null;
      await prisma.aiGeneration.updateMany({
        where: { id: genId },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          resultAssetKey: assetKey,
        },
      });
    },
    { name: "standInImageFinalize" },
  );
  return { ok: true };
}
DBOS.registerWorkflow(standInGenerateImageFn, {
  name: GENERATE_IMAGE_WORKFLOW_NAME,
});

// Task #33: a STAND-IN generateAudio — drives the SAME AiGeneration row transitions the real
// audio workflow drives (running → succeeded + resultAssetKey), keyed by workflowID =
// generationId, for BOTH audio kinds. The REAL workflow's speech/S3 behaviour is proven by the
// dbos repo's generate-audio.e2e.ts; here we only prove the API wires narration+music (POST no
// longer 501s) and surfaces resultAssetKey on the DTO.
async function standInGenerateAudioFn(_payload: unknown): Promise<{ ok: true }> {
  const genId = DBOS.workflowID!;
  await DBOS.runStep(
    async () => {
      const row = await prisma.aiGeneration.findUnique({ where: { id: genId } });
      const assetKey = row?.projectId ? buildAssetKey(row.projectId, genId) : null;
      await prisma.aiGeneration.updateMany({
        where: { id: genId },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          resultAssetKey: assetKey,
          resultJson: { kind: row?.kind, providerGenerationId: "gen_stub_1" } as any,
        },
      });
    },
    { name: "standInAudioFinalize" },
  );
  return { ok: true };
}
DBOS.registerWorkflow(standInGenerateAudioFn, {
  name: GENERATE_AUDIO_WORKFLOW_NAME,
});

// Task #34: a STAND-IN generateVideo — drives the SAME AiGeneration row transitions the real
// video workflow drives (running → succeeded + resultAssetKey), keyed by workflowID =
// generationId. The REAL workflow's async submit/poll/download/upload + crash-replay behaviour is
// proven by the dbos repo's generate-video.e2e.ts; here we only prove the API wires video (POST no
// longer 501s) and surfaces resultAssetKey on the DTO.
async function standInGenerateVideoFn(_payload: unknown): Promise<{ ok: true }> {
  const genId = DBOS.workflowID!;
  await DBOS.runStep(
    async () => {
      const row = await prisma.aiGeneration.findUnique({ where: { id: genId } });
      const assetKey = row?.projectId ? buildAssetKey(row.projectId, genId) : null;
      await prisma.aiGeneration.updateMany({
        where: { id: genId },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          providerJobId: "vid_stub_1",
          resultAssetKey: assetKey,
          resultJson: { kind: "video", providerJobId: "vid_stub_1" } as any,
        },
      });
    },
    { name: "standInVideoFinalize" },
  );
  return { ok: true };
}
DBOS.registerWorkflow(standInGenerateVideoFn, {
  name: GENERATE_VIDEO_WORKFLOW_NAME,
});

let app: FastifyInstance;
let baseUrl: string;
let enqueuer: {
  enqueue: (o: any, p: unknown) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  close: () => Promise<void>;
};

beforeAll(async () => {
  DBOS.setConfig({ name: "supagloo-api-ai-e2e", systemDatabaseUrl: DBOS_URL });
  await DBOS.launch();
  await DBOS.registerQueue(AI_GENERATION_QUEUE_NAME, { workerConcurrency: 8 });

  enqueuer = makeDbosEnqueuer({ systemDatabaseUrl: DBOS_URL });

  const authService = new AuthService({
    prisma,
    verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
    sessionTtlMs: SESSION_TTL_MS,
  });
  const projectsService = new ProjectsService({ prisma });
  const aiService = new AiGenerationsService({
    prisma,
    enqueue: enqueuer.enqueue,
    cancel: enqueuer.cancel,
  });

  app = buildApp({
    auth: {
      authService,
      env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
    },
    projects: { service: projectsService },
    aiGenerations: { service: aiService },
  });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);

afterAll(async () => {
  disarmGates();
  releaseA?.();
  releaseB?.();
  if (app) await app.close();
  await enqueuer?.close().catch(() => {});
  await DBOS.shutdown();
  await prisma.$disconnect().catch(() => {});
});

async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
  const s = stamp();
  const token = `ai-e2e-${tag}-${s}`;
  const res = await fetch(`${baseUrl}/v1/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      users: [
        {
          youversionUserId: `yv-ai-${tag}-${s}`,
          displayName: `AI E2E ${tag}`,
          email: `ai-${tag}-${s}@example.test`,
          avatarInitials: "AE",
          sessionToken: token,
        },
      ],
    }),
  });
  const body = await res.json();
  return { token, userId: body.users[0].user.id };
}

async function seedProject(userId: string, tag: string): Promise<string> {
  const s = stamp();
  const project = await prisma.project.create({
    data: {
      slug: `ai-${tag}-${s}`,
      ownerId: userId,
      name: `AI Project ${tag}`,
      repoOwner: "ashtable",
      repoName: `ai-${tag}-${s}`,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "main",
    },
  });
  return project.id;
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

async function getGeneration(token: string, id: string) {
  const res = await api(`/ai/generations/${id}`, token);
  expect(res.status).toBe(200);
  return (await res.json()).generation;
}

async function pollUntilStatus(
  token: string,
  id: string,
  status: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gen = await getGeneration(token, id);
    if (gen.status === status) return gen;
    await sleep(150);
  }
  throw new Error(`generation ${id} did not reach ${status} within ${timeoutMs}ms`);
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error("waitFor timed out");
}

function storyboardBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "storyboard",
    provider: "openrouter",
    model: "openai/gpt-4o",
    input: { brief: "A short Psalm 121 devotional" },
    ...overrides,
  };
}

function narrationBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "narration",
    provider: "openrouter",
    model: "stub/speech-model",
    input: {
      voice: { description: "warm, weathered baritone", label: "JEJ-STYLE" },
      scenes: [
        { sceneId: "s1", scriptText: "I lift up my eyes to the hills." },
        { sceneId: "s2", scriptText: "From whence cometh my help?" },
      ],
    },
    ...overrides,
  };
}

function musicBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "music",
    provider: "openrouter",
    model: "stub/music-model",
    input: { style: "Swelling cinematic strings", durationSeconds: 30 },
    ...overrides,
  };
}

function videoBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "video",
    provider: "openrouter",
    model: "stub/video-model",
    input: { prompt: "a dove descends over still water", durationSeconds: 6, aspectRatio: "9:16" },
    ...overrides,
  };
}

describe("e2e: POST /v1/ai/generations + poll — full round trip", () => {
  it("creates + enqueues, polls queued→running→succeeded, surfaces resultJson", async () => {
    armGates();
    const owner = await seedUser("flow");

    const created = await api("/ai/generations", owner.token, {
      method: "POST",
      body: storyboardBody(),
    });
    expect(created.status).toBe(201);
    const { generationId } = await created.json();
    expect(generationId).toBeTruthy();

    // Durably enqueued under workflowID = generationId (exactly one).
    await waitFor(
      async () =>
        (await DBOS.listWorkflows({ workflowIDs: [generationId] })).length === 1,
      10_000,
    );

    // queued — the worker is parked at gate A.
    const queued = await getGeneration(owner.token, generationId);
    expect(queued.status).toBe("queued");
    expect(queued.kind).toBe("storyboard");
    expect(queued.provider).toBe("openrouter");
    expect(queued.resultJson).toBeNull();

    // release A → running (parked at gate B).
    releaseA!();
    await pollUntilStatus(owner.token, generationId, "running");

    // release B → succeeded, resultJson + tokenUsage surfaced.
    releaseB!();
    const done = await pollUntilStatus(owner.token, generationId, "succeeded");
    expect(done.resultJson).toEqual(STUB_RESULT);
    expect(done.tokenUsage).toEqual(STUB_USAGE);
    expect(done.completedAt).toBeTruthy();
  }, 60_000);
});

describe("e2e: POST validation gates (before any row is created)", () => {
  it("422s an out-of-matrix pair (image+gloo) and creates no row", async () => {
    disarmGates();
    const owner = await seedUser("matrix");
    const before = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    const res = await api("/ai/generations", owner.token, {
      method: "POST",
      body: { kind: "image", provider: "gloo", model: "m", input: { prompt: "x" } },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("kind_provider_incompatible");
    const after = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    expect(after).toBe(before);
  });

  it("400s a video POST with no prompt (the real GenerateVideoInputSchema, Task #34)", async () => {
    disarmGates();
    const owner = await seedUser("vid-noprompt");
    const before = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    const res = await api("/ai/generations", owner.token, {
      method: "POST",
      body: { kind: "video", provider: "openrouter", model: "m", input: {} },
    });
    expect(res.status).toBe(400);
    const after = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    expect(after).toBe(before);
  });

  it("400s a narration POST whose input is not a real narration spec (Task #33)", async () => {
    disarmGates();
    const owner = await seedUser("narr-badinput");
    const before = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    const res = await api("/ai/generations", owner.token, {
      method: "POST",
      body: { kind: "narration", provider: "openrouter", model: "m", input: {} },
    });
    expect(res.status).toBe(400);
    const after = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    expect(after).toBe(before);
  });

  it("400s an image POST with no prompt (the real GenerateImageInputSchema, Task #32)", async () => {
    disarmGates();
    const owner = await seedUser("img-noprompt");
    const before = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    const res = await api("/ai/generations", owner.token, {
      method: "POST",
      body: { kind: "image", provider: "openrouter", model: "m", input: {} },
    });
    expect(res.status).toBe(400);
    const after = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    expect(after).toBe(before);
  });

  it("404s a POST whose projectId is foreign, creating no row", async () => {
    disarmGates();
    const owner = await seedUser("foreign-proj");
    const other = await seedUser("proj-owner");
    const foreignProjectId = await seedProject(other.userId, "foreign");
    const before = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    const res = await api("/ai/generations", owner.token, {
      method: "POST",
      body: storyboardBody({ projectId: foreignProjectId }),
    });
    expect(res.status).toBe(404);
    const after = await prisma.aiGeneration.count({ where: { userId: owner.userId } });
    expect(after).toBe(before);
  });

  it("400s a malformed body (storyboard input missing brief)", async () => {
    disarmGates();
    const owner = await seedUser("badbody");
    const res = await api("/ai/generations", owner.token, {
      method: "POST",
      body: { kind: "storyboard", provider: "openrouter", model: "m", input: {} },
    });
    expect(res.status).toBe(400);
  });
});

describe("e2e: image is wired (Task #32)", () => {
  it("creates + enqueues generateImage, reaches succeeded, and surfaces resultAssetKey", async () => {
    disarmGates();
    const owner = await seedUser("img-wired");
    const projectId = await seedProject(owner.userId, "img");

    const created = await api("/ai/generations", owner.token, {
      method: "POST",
      body: {
        kind: "image",
        provider: "openrouter",
        model: "stub/image-model",
        projectId,
        input: { prompt: "a serene sunrise over hills" },
      },
    });
    expect(created.status).toBe(201);
    const { generationId } = await created.json();
    expect(generationId).toBeTruthy();

    const done = await pollUntilStatus(owner.token, generationId, "succeeded");
    expect(done.kind).toBe("image");
    expect(done.resultAssetKey).toBe(buildAssetKey(projectId, generationId));
    expect(done.resultJson).toBeNull();
  }, 60_000);
});

describe("e2e: audio is wired (Task #33)", () => {
  it("creates + enqueues generateAudio for narration, reaches succeeded, surfaces resultAssetKey", async () => {
    disarmGates();
    const owner = await seedUser("narr-wired");
    const projectId = await seedProject(owner.userId, "narr");

    const created = await api("/ai/generations", owner.token, {
      method: "POST",
      body: narrationBody({ projectId }),
    });
    expect(created.status).toBe(201);
    const { generationId } = await created.json();
    expect(generationId).toBeTruthy();

    const done = await pollUntilStatus(owner.token, generationId, "succeeded");
    expect(done.kind).toBe("narration");
    expect(done.resultAssetKey).toBe(buildAssetKey(projectId, generationId));
  }, 60_000);

  it("creates + enqueues generateAudio for music (same workflow), reaches succeeded", async () => {
    disarmGates();
    const owner = await seedUser("music-wired");
    const projectId = await seedProject(owner.userId, "music");

    const created = await api("/ai/generations", owner.token, {
      method: "POST",
      body: musicBody({ projectId }),
    });
    expect(created.status).toBe(201);
    const { generationId } = await created.json();

    const done = await pollUntilStatus(owner.token, generationId, "succeeded");
    expect(done.kind).toBe("music");
    expect(done.resultAssetKey).toBe(buildAssetKey(projectId, generationId));
  }, 60_000);
});

describe("e2e: video is wired (Task #34)", () => {
  it("creates + enqueues generateVideo, reaches succeeded, and surfaces resultAssetKey", async () => {
    disarmGates();
    const owner = await seedUser("vid-wired");
    const projectId = await seedProject(owner.userId, "vid");

    const created = await api("/ai/generations", owner.token, {
      method: "POST",
      body: videoBody({ projectId }),
    });
    expect(created.status).toBe(201);
    const { generationId } = await created.json();
    expect(generationId).toBeTruthy();

    const done = await pollUntilStatus(owner.token, generationId, "succeeded");
    expect(done.kind).toBe("video");
    expect(done.resultAssetKey).toBe(buildAssetKey(projectId, generationId));
  }, 60_000);
});

describe("e2e: POST /v1/ai/generations/:id/cancel", () => {
  it("cancels a queued generation → 200 canceled, then 409 on re-cancel", async () => {
    armGates(); // hold the stand-in at gate A so the row stays cancelable.
    const owner = await seedUser("cancel");

    const created = await api("/ai/generations", owner.token, {
      method: "POST",
      body: storyboardBody(),
    });
    expect(created.status).toBe(201);
    const { generationId } = await created.json();

    await waitFor(
      async () =>
        (await DBOS.listWorkflows({ workflowIDs: [generationId] })).length === 1,
      10_000,
    );
    expect((await getGeneration(owner.token, generationId)).status).toBe("queued");

    // Cancel → 200 with the updated (canceled) generation.
    const cancelRes = await api(`/ai/generations/${generationId}/cancel`, owner.token, {
      method: "POST",
    });
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()).generation.status).toBe("canceled");

    // The row reflects canceled on a fresh GET.
    expect((await getGeneration(owner.token, generationId)).status).toBe("canceled");

    // Re-cancel a terminal generation → 409.
    const again = await api(`/ai/generations/${generationId}/cancel`, owner.token, {
      method: "POST",
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("generation_not_cancelable");

    releaseA!();
    releaseB!();
  }, 60_000);
});

describe("e2e: GET /v1/projects/:id/generations — project-scoped list", () => {
  it("lists a project's generations newest-first", async () => {
    disarmGates(); // let both stand-ins run to completion.
    const owner = await seedUser("list");
    const projectId = await seedProject(owner.userId, "list");

    const first = await api("/ai/generations", owner.token, {
      method: "POST",
      body: storyboardBody({ projectId }),
    });
    expect(first.status).toBe(201);
    const firstId = (await first.json()).generationId;
    await sleep(20); // ensure distinct createdAt for a deterministic order.
    const second = await api("/ai/generations", owner.token, {
      method: "POST",
      body: storyboardBody({ projectId, kind: "script" }),
    });
    expect(second.status).toBe(201);
    const secondId = (await second.json()).generationId;

    const listRes = await api(`/projects/${projectId}/generations`, owner.token);
    expect(listRes.status).toBe(200);
    const { generations } = await listRes.json();
    const ids = generations.map((g: any) => g.id);
    expect(ids).toContain(firstId);
    expect(ids).toContain(secondId);
    // Newest first: the second-created generation precedes the first.
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));
  }, 60_000);
});

describe("e2e: ownership scoping + auth", () => {
  it("404s a by-id GET for a foreign owner", async () => {
    disarmGates();
    const owner = await seedUser("own");
    const other = await seedUser("intruder");
    const created = await api("/ai/generations", owner.token, {
      method: "POST",
      body: storyboardBody(),
    });
    const { generationId } = await created.json();
    expect((await api(`/ai/generations/${generationId}`, other.token)).status).toBe(404);
    expect((await api(`/ai/generations/does-not-exist`, owner.token)).status).toBe(404);
  });

  it("404s a project-scoped list for a foreign project", async () => {
    disarmGates();
    const owner = await seedUser("list-own");
    const other = await seedUser("list-intruder");
    const projectId = await seedProject(owner.userId, "scoped");
    expect((await api(`/projects/${projectId}/generations`, other.token)).status).toBe(404);
  });

  it("401s every route without a bearer token", async () => {
    expect(
      (
        await api("/ai/generations", undefined, {
          method: "POST",
          body: storyboardBody(),
        })
      ).status,
    ).toBe(401);
    expect((await api("/ai/generations/x")).status).toBe(401);
    expect((await api("/projects/x/generations")).status).toBe(401);
    expect((await api("/ai/generations/x/cancel", undefined, { method: "POST" })).status).toBe(
      401,
    );
  });
});
