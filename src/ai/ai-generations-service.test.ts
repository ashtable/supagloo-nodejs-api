import { describe, it, expect } from "vitest";
import {
  AI_GENERATION_QUEUE_NAME,
  GENERATE_AUDIO_WORKFLOW_NAME,
  GENERATE_IMAGE_WORKFLOW_NAME,
  GENERATE_SCRIPT_WORKFLOW_NAME,
  GENERATE_VIDEO_WORKFLOW_NAME,
  type PrismaClient,
} from "@supagloo/database-lib";
import {
  AiGenerationsService,
  type EnqueueOptions,
} from "./ai-generations-service";
import {
  AiGenerationNotFoundError,
  GenerationNotCancelableError,
  KindProviderIncompatibleError,
} from "./errors";
import { ProjectNotFoundError } from "../projects/errors";

// Unit tests for AiGenerationsService (Task #31, design-delta §2.8/§7/§8). A FAKE Prisma
// + recorder enqueue/cancel + fixed clock/id let us assert, DB-free:
//   - createGeneration: matrix 422 (before any row/enqueue), unsupported-kind 501 (before
//     any row/enqueue), foreign-project 404, and the happy path (row written + enqueue on
//     the ai-generation queue with workflowID = generationId + { generationId } payload);
//   - getGeneration: direct userId scoping (foreign / missing → 404);
//   - listProjectGenerations: project owner-scoping (foreign → 404) + createdAt-desc order;
//   - cancelGeneration: queued/running → cancel + row-flip to canceled; terminal → 409;
//     the cancel-vs-complete race (conditional update matches 0 → no clobber).

type Call = { op: string; args: any };

interface FakeConfig {
  project?: unknown; // project.findFirst result (ownership resolve)
  generation?: unknown; // aiGeneration.findFirst result
  generations?: unknown[]; // aiGeneration.findMany result
  updatedCount?: number; // aiGeneration.updateMany result count
  reReadGeneration?: unknown; // second aiGeneration.findFirst (cancel re-read)
}

function makeFake(config: FakeConfig) {
  const calls: Call[] = [];
  // findFirst may be called twice by cancel (resolve, then re-read); serve the
  // re-read value on the 2nd call when provided.
  let findFirstCount = 0;
  const prisma = {
    project: {
      findFirst: (args: any) => {
        calls.push({ op: "project.findFirst", args });
        return Promise.resolve(config.project ?? null);
      },
    },
    aiGeneration: {
      findFirst: (args: any) => {
        calls.push({ op: "aiGeneration.findFirst", args });
        findFirstCount += 1;
        if (findFirstCount >= 2 && config.reReadGeneration !== undefined) {
          return Promise.resolve(config.reReadGeneration);
        }
        return Promise.resolve(config.generation ?? null);
      },
      findMany: (args: any) => {
        calls.push({ op: "aiGeneration.findMany", args });
        return Promise.resolve(config.generations ?? []);
      },
      create: (args: any) => {
        calls.push({ op: "aiGeneration.create", args });
        return Promise.resolve({ ...args.data });
      },
      updateMany: (args: any) => {
        calls.push({ op: "aiGeneration.updateMany", args });
        return Promise.resolve({ count: config.updatedCount ?? 1 });
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

const has = (calls: Call[], op: string) => calls.some((c) => c.op === op);
const find = (calls: Call[], op: string) => calls.find((c) => c.op === op)!;

function makeEnqueueRecorder() {
  const enqueued: { opts: EnqueueOptions; payload: unknown }[] = [];
  return {
    enqueue: async (opts: EnqueueOptions, payload: unknown) => {
      enqueued.push({ opts, payload });
    },
    enqueued,
  };
}
function makeCancelRecorder() {
  const canceled: string[] = [];
  return {
    cancel: async (workflowID: string) => {
      canceled.push(workflowID);
    },
    canceled,
  };
}

const NOW = new Date("2026-07-22T00:00:00.000Z");
function makeService(fake: { prisma: PrismaClient }, seams: any) {
  return new AiGenerationsService({
    prisma: fake.prisma,
    enqueue: seams.enqueue,
    cancel: seams.cancel,
    now: () => NOW,
    generateId: () => "gen-fixed",
  });
}

const STORYBOARD_REQ = {
  kind: "storyboard" as const,
  provider: "openrouter" as const,
  model: "openai/gpt-4o",
  projectId: "proj-1",
  sceneId: "scene-1",
  input: { brief: "Psalm 121" },
};

describe("AiGenerationsService.createGeneration", () => {
  it("creates a queued row and enqueues generateScript with workflowID = generationId", async () => {
    const fake = makeFake({ project: { id: "proj-1", ownerId: "u1" } });
    const enq = makeEnqueueRecorder();
    const cancel = makeCancelRecorder();
    const service = makeService(fake, { enqueue: enq.enqueue, cancel: cancel.cancel });

    const result = await service.createGeneration("u1", STORYBOARD_REQ);
    expect(result).toEqual({ generationId: "gen-fixed" });

    const create = find(fake.calls, "aiGeneration.create");
    expect(create.args.data).toMatchObject({
      id: "gen-fixed",
      userId: "u1",
      projectId: "proj-1",
      sceneId: "scene-1",
      kind: "storyboard",
      provider: "openrouter",
      model: "openai/gpt-4o",
      status: "queued",
    });

    // Enqueue AFTER the row is written, with the { generationId } payload.
    expect(enq.enqueued).toHaveLength(1);
    expect(enq.enqueued[0].opts).toEqual({
      workflowName: GENERATE_SCRIPT_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
      workflowID: "gen-fixed",
    });
    expect(enq.enqueued[0].payload).toEqual({ generationId: "gen-fixed" });
  });

  it("stores projectId/sceneId as null when omitted (a project-less generation)", async () => {
    const fake = makeFake({});
    const enq = makeEnqueueRecorder();
    const service = makeService(fake, {
      enqueue: enq.enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    await service.createGeneration("u1", {
      kind: "script",
      provider: "gloo",
      model: "m",
      input: { brief: "x" },
    });
    const create = find(fake.calls, "aiGeneration.create");
    expect(create.args.data.projectId).toBeNull();
    expect(create.args.data.sceneId).toBeNull();
    // No project ownership check when projectId is absent.
    expect(has(fake.calls, "project.findFirst")).toBe(false);
  });

  it("422s an out-of-matrix {kind, provider} pair BEFORE any row or enqueue", async () => {
    const fake = makeFake({ project: { id: "proj-1", ownerId: "u1" } });
    const enq = makeEnqueueRecorder();
    const service = makeService(fake, {
      enqueue: enq.enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    await expect(
      service.createGeneration("u1", {
        kind: "image",
        provider: "gloo",
        model: "m",
        input: { prompt: "x" },
        projectId: "proj-1",
      }),
    ).rejects.toBeInstanceOf(KindProviderIncompatibleError);
    expect(has(fake.calls, "aiGeneration.create")).toBe(false);
    expect(enq.enqueued).toHaveLength(0);
  });

  it("wires video (Task #34): creates the row + enqueues generateVideo on the ai-generation queue", async () => {
    const fake = makeFake({ project: { id: "proj-1", ownerId: "u1" } });
    const enq = makeEnqueueRecorder();
    const service = makeService(fake, {
      enqueue: enq.enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    const result = await service.createGeneration("u1", {
      kind: "video",
      provider: "openrouter",
      model: "some/video-model",
      input: { prompt: "a dove descends over still water", durationSeconds: 6 },
      projectId: "proj-1",
    });
    expect(result).toEqual({ generationId: "gen-fixed" });

    const create = find(fake.calls, "aiGeneration.create");
    expect(create.args.data).toMatchObject({
      id: "gen-fixed",
      kind: "video",
      provider: "openrouter",
      projectId: "proj-1",
      status: "queued",
    });
    expect(enq.enqueued).toHaveLength(1);
    expect(enq.enqueued[0].opts).toEqual({
      workflowName: GENERATE_VIDEO_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
      workflowID: "gen-fixed",
    });
    expect(enq.enqueued[0].payload).toEqual({ generationId: "gen-fixed" });
  });

  it("wires narration (Task #33): creates the row + enqueues generateAudio on the ai-generation queue", async () => {
    const fake = makeFake({ project: { id: "proj-1", ownerId: "u1" } });
    const enq = makeEnqueueRecorder();
    const service = makeService(fake, {
      enqueue: enq.enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    const result = await service.createGeneration("u1", {
      kind: "narration",
      provider: "openrouter",
      model: "some/speech-model",
      input: {
        voice: { description: "warm baritone" },
        scenes: [{ sceneId: "s1", scriptText: "I lift up my eyes" }],
      },
      projectId: "proj-1",
    });
    expect(result).toEqual({ generationId: "gen-fixed" });

    const create = find(fake.calls, "aiGeneration.create");
    expect(create.args.data).toMatchObject({
      id: "gen-fixed",
      kind: "narration",
      provider: "openrouter",
      projectId: "proj-1",
      status: "queued",
    });
    expect(enq.enqueued).toHaveLength(1);
    expect(enq.enqueued[0].opts).toEqual({
      workflowName: GENERATE_AUDIO_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
      workflowID: "gen-fixed",
    });
    expect(enq.enqueued[0].payload).toEqual({ generationId: "gen-fixed" });
  });

  it("wires music (Task #33): enqueues generateAudio (same workflow as narration)", async () => {
    const fake = makeFake({ project: { id: "proj-1", ownerId: "u1" } });
    const enq = makeEnqueueRecorder();
    const service = makeService(fake, {
      enqueue: enq.enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    await service.createGeneration("u1", {
      kind: "music",
      provider: "openrouter",
      model: "some/music-model",
      input: { style: "Swelling strings", durationSeconds: 30 },
      projectId: "proj-1",
    });
    expect(enq.enqueued[0].opts).toMatchObject({
      workflowName: GENERATE_AUDIO_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
    });
  });

  it("wires image (Task #32): creates the row + enqueues generateImage on the ai-generation queue", async () => {
    const fake = makeFake({ project: { id: "proj-1", ownerId: "u1" } });
    const enq = makeEnqueueRecorder();
    const service = makeService(fake, {
      enqueue: enq.enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    const result = await service.createGeneration("u1", {
      kind: "image",
      provider: "openrouter",
      model: "some/image-model",
      input: { prompt: "a serene sunrise over hills" },
      projectId: "proj-1",
    });
    expect(result).toEqual({ generationId: "gen-fixed" });

    const create = find(fake.calls, "aiGeneration.create");
    expect(create.args.data).toMatchObject({
      id: "gen-fixed",
      kind: "image",
      provider: "openrouter",
      projectId: "proj-1",
      status: "queued",
    });
    expect(enq.enqueued).toHaveLength(1);
    expect(enq.enqueued[0].opts).toEqual({
      workflowName: GENERATE_IMAGE_WORKFLOW_NAME,
      queueName: AI_GENERATION_QUEUE_NAME,
      workflowID: "gen-fixed",
    });
    expect(enq.enqueued[0].payload).toEqual({ generationId: "gen-fixed" });
  });

  it("404s (and writes nothing) when the given projectId is foreign/missing", async () => {
    const fake = makeFake({ project: null }); // ownership resolve misses
    const enq = makeEnqueueRecorder();
    const service = makeService(fake, {
      enqueue: enq.enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    await expect(
      service.createGeneration("u1", STORYBOARD_REQ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(has(fake.calls, "aiGeneration.create")).toBe(false);
    expect(enq.enqueued).toHaveLength(0);
  });

  it("scopes the project ownership check to the caller", async () => {
    const fake = makeFake({ project: { id: "proj-1", ownerId: "u1" } });
    const service = makeService(fake, {
      enqueue: makeEnqueueRecorder().enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    await service.createGeneration("u1", STORYBOARD_REQ);
    expect(find(fake.calls, "project.findFirst").args.where).toMatchObject({
      id: "proj-1",
      ownerId: "u1",
      deletedAt: null,
    });
  });
});

describe("AiGenerationsService.getGeneration", () => {
  it("returns the row scoped directly on userId", async () => {
    const row = { id: "gen-1", userId: "u1", kind: "script" };
    const fake = makeFake({ generation: row });
    const service = makeService(fake, {
      enqueue: makeEnqueueRecorder().enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    const got = await service.getGeneration("u1", "gen-1");
    expect(got).toBe(row);
    expect(find(fake.calls, "aiGeneration.findFirst").args.where).toEqual({
      id: "gen-1",
      userId: "u1",
    });
  });

  it("404s a missing / foreign generation", async () => {
    const fake = makeFake({ generation: null });
    const service = makeService(fake, {
      enqueue: makeEnqueueRecorder().enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    await expect(
      service.getGeneration("u1", "nope"),
    ).rejects.toBeInstanceOf(AiGenerationNotFoundError);
  });
});

describe("AiGenerationsService.listProjectGenerations", () => {
  it("404s a foreign/deleted project (never leaks generations)", async () => {
    const fake = makeFake({ project: null });
    const service = makeService(fake, {
      enqueue: makeEnqueueRecorder().enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    await expect(
      service.listProjectGenerations("u1", "proj-x"),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(has(fake.calls, "aiGeneration.findMany")).toBe(false);
  });

  it("returns the project's generations newest-first (createdAt desc, id desc tiebreak)", async () => {
    const rows = [
      { id: "a", createdAt: new Date("2026-07-22T00:00:01Z") },
      { id: "c", createdAt: new Date("2026-07-22T00:00:03Z") },
      { id: "b1", createdAt: new Date("2026-07-22T00:00:02Z") },
      { id: "b2", createdAt: new Date("2026-07-22T00:00:02Z") },
    ];
    const fake = makeFake({ project: { id: "proj-1", ownerId: "u1" }, generations: rows });
    const service = makeService(fake, {
      enqueue: makeEnqueueRecorder().enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    const listed = await service.listProjectGenerations("u1", "proj-1");
    expect(listed.map((g: any) => g.id)).toEqual(["c", "b2", "b1", "a"]);
    expect(find(fake.calls, "project.findFirst").args.where).toMatchObject({
      id: "proj-1",
      ownerId: "u1",
      deletedAt: null,
    });
  });
});

describe("AiGenerationsService.cancelGeneration", () => {
  it("cancels the workflow and flips a running row to canceled", async () => {
    const running = {
      id: "gen-1",
      userId: "u1",
      status: "running",
      kind: "script",
    };
    const canceledRow = { ...running, status: "canceled", completedAt: NOW };
    const fake = makeFake({ generation: running, reReadGeneration: canceledRow, updatedCount: 1 });
    const cancel = makeCancelRecorder();
    const service = makeService(fake, {
      enqueue: makeEnqueueRecorder().enqueue,
      cancel: cancel.cancel,
    });

    const result = await service.cancelGeneration("u1", "gen-1");
    expect(cancel.canceled).toEqual(["gen-1"]); // DBOS workflow canceled
    const upd = find(fake.calls, "aiGeneration.updateMany");
    // Conditional flip: only non-terminal rows, guarding the cancel-vs-complete race.
    expect(upd.args.where).toMatchObject({
      id: "gen-1",
      status: { in: ["queued", "running"] },
    });
    expect(upd.args.data).toMatchObject({ status: "canceled" });
    expect((result as any).status).toBe("canceled");
  });

  it("409s an already-terminal generation (succeeded/failed/canceled) — no cancel, no update", async () => {
    for (const status of ["succeeded", "failed", "canceled"] as const) {
      const fake = makeFake({ generation: { id: "g", userId: "u1", status } });
      const cancel = makeCancelRecorder();
      const service = makeService(fake, {
        enqueue: makeEnqueueRecorder().enqueue,
        cancel: cancel.cancel,
      });
      await expect(
        service.cancelGeneration("u1", "g"),
      ).rejects.toBeInstanceOf(GenerationNotCancelableError);
      expect(cancel.canceled).toHaveLength(0);
      expect(has(fake.calls, "aiGeneration.updateMany")).toBe(false);
    }
  });

  it("404s a missing / foreign generation before doing anything", async () => {
    const fake = makeFake({ generation: null });
    const cancel = makeCancelRecorder();
    const service = makeService(fake, {
      enqueue: makeEnqueueRecorder().enqueue,
      cancel: cancel.cancel,
    });
    await expect(
      service.cancelGeneration("u1", "nope"),
    ).rejects.toBeInstanceOf(AiGenerationNotFoundError);
    expect(cancel.canceled).toHaveLength(0);
  });

  it("does not clobber a result that won the race (conditional update matched 0 rows)", async () => {
    // Row read as running, but between read and cancel the workflow wrote `succeeded`;
    // the conditional updateMany matches 0 rows and the re-read reflects the winner.
    const running = { id: "gen-1", userId: "u1", status: "running" };
    const succeeded = { id: "gen-1", userId: "u1", status: "succeeded" };
    const fake = makeFake({
      generation: running,
      reReadGeneration: succeeded,
      updatedCount: 0,
    });
    const service = makeService(fake, {
      enqueue: makeEnqueueRecorder().enqueue,
      cancel: makeCancelRecorder().cancel,
    });
    const result = await service.cancelGeneration("u1", "gen-1");
    expect((result as any).status).toBe("succeeded"); // honest final state, not clobbered
  });
});
