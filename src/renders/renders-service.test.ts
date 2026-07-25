import { describe, it, expect } from "vitest";
import {
  RENDER_QUEUE_NAME,
  RENDER_WORKFLOW_NAME,
  RenderWorkflowPayloadSchema,
  buildRenderOutputKey,
  type PrismaClient,
} from "@supagloo/database-lib";
import {
  CANCELABLE_RENDER_STATUSES,
  RendersService,
  type EnqueueOptions,
} from "./renders-service";
import { RenderNotCancelableError, RenderNotFoundError } from "./errors";
import { ProjectNotFoundError } from "../projects/errors";

// Unit tests for RendersService (Task #37, design-delta §2.7/§6c/§8). A FAKE Prisma +
// recorder enqueue/cancel/presign + fixed clock/id let us assert, DB-free:
//   - createRender: project owner-scoping (foreign/deleted → 404 before any write),
//     version-belongs-to-project scoping (→ 404), the queued row (framesTotal 0 per the
//     plan's D1), Project.lastRenderJobId (D3), and the post-write enqueue on the render
//     queue with workflowID = renderJobId + the { renderJobId } echo payload;
//   - getRender / listMyRenders: DIRECT RenderJob.userId scoping;
//   - cancelRender: DBOS cancel BEFORE the row write, a CONDITIONAL flip that cannot
//     clobber a terminal row (the race guard dbos `markRenderCanceled` is written for),
//     409 on an already-terminal row;
//   - presignRenderDownload: completed + outputAssetKey gating, delegating with exactly
//     buildRenderOutputKey(id).
//
// Prisma ops AND the enqueue/cancel/presign seams all record onto ONE shared `calls`
// timeline, so the two ORDERINGS this surface's safety argument rests on — write before
// enqueue, cancel before the row flip — are assertable as real relative positions
// (`at(...)`) rather than as mere presence.

type Call = { op: string; args: any };

interface FakeConfig {
  project?: unknown; // project.findFirst result (ownership resolve)
  version?: unknown; // projectVersion.findFirst result
  render?: unknown; // renderJob.findFirst result
  renders?: unknown[]; // renderJob.findMany result
  updatedCount?: number; // renderJob.updateMany result count
  reReadRender?: unknown; // second renderJob.findFirst (cancel re-read)
}

function makeFake(config: FakeConfig) {
  const calls: Call[] = [];
  let findFirstCount = 0;
  const prisma = {
    project: {
      findFirst: (args: any) => {
        calls.push({ op: "project.findFirst", args });
        return Promise.resolve(config.project ?? null);
      },
      update: (args: any) => {
        calls.push({ op: "project.update", args });
        return Promise.resolve({});
      },
    },
    projectVersion: {
      findFirst: (args: any) => {
        calls.push({ op: "projectVersion.findFirst", args });
        return Promise.resolve(config.version ?? null);
      },
    },
    renderJob: {
      findFirst: (args: any) => {
        calls.push({ op: "renderJob.findFirst", args });
        findFirstCount += 1;
        if (findFirstCount >= 2 && config.reReadRender !== undefined) {
          return Promise.resolve(config.reReadRender);
        }
        return Promise.resolve(config.render ?? null);
      },
      findMany: (args: any) => {
        calls.push({ op: "renderJob.findMany", args });
        return Promise.resolve(config.renders ?? []);
      },
      create: (args: any) => {
        calls.push({ op: "renderJob.create", args });
        return Promise.resolve({ ...args.data });
      },
      updateMany: (args: any) => {
        calls.push({ op: "renderJob.updateMany", args });
        return Promise.resolve({ count: config.updatedCount ?? 1 });
      },
    },
    // The create path writes the row + Project.lastRenderJobId atomically. The fake
    // simply awaits whatever promises the service hands it (the real client runs them
    // in one transaction) — the assertions are on the recorded operations.
    $transaction: (ops: unknown) => {
      calls.push({ op: "$transaction", args: { size: Array.isArray(ops) ? ops.length : 1 } });
      return Promise.all(ops as Promise<unknown>[]);
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

const has = (calls: Call[], op: string) => calls.some((c) => c.op === op);
const find = (calls: Call[], op: string) => calls.find((c) => c.op === op)!;

/**
 * Position of `op` on the SHARED timeline — the oracle for every ordering assertion.
 *
 * THROWS when the op never happened, deliberately: `findIndex` returns -1 for a missing
 * op, and `expect(-1).toBeLessThan(0)` passes — an ordering assertion whose first operand
 * never ran would silently report success. An ordering claim about an op that did not
 * happen is a bug in the test, not a pass.
 */
function at(calls: Call[], op: string): number {
  const i = calls.findIndex((c) => c.op === op);
  if (i === -1) {
    throw new Error(
      `expected op ${op} on the call timeline; saw: ${calls.map((c) => c.op).join(" → ") || "(nothing)"}`,
    );
  }
  return i;
}

// The enqueue / cancel recorders push onto the SAME `calls` timeline as the Prisma fake
// (as `dbos.enqueue` / `dbos.cancel`). Before this they kept private arrays, so no
// cross-array ordering was observable and both "orders" the service depends on —
// write-then-enqueue and cancel-then-write — were asserted only by presence. Both are
// load-bearing (see U-RS4 / U-RS8), so the timeline is REQUIRED, not optional: every
// recorder factory takes it.
function makeEnqueueRecorder(calls: Call[]) {
  const enqueued: { opts: EnqueueOptions; payload: unknown }[] = [];
  return {
    enqueue: async (opts: EnqueueOptions, payload: unknown) => {
      calls.push({ op: "dbos.enqueue", args: { opts, payload } });
      enqueued.push({ opts, payload });
    },
    enqueued,
  };
}
function makeCancelRecorder(calls: Call[]) {
  const canceled: string[] = [];
  return {
    cancel: async (workflowID: string) => {
      calls.push({ op: "dbos.cancel", args: { workflowID } });
      canceled.push(workflowID);
    },
    canceled,
  };
}
function makePresignRecorder(calls: Call[]) {
  const presigned: { userId: string; key: string }[] = [];
  return {
    presignDownload: async (userId: string, key: string) => {
      calls.push({ op: "s3.presignDownload", args: { userId, key } });
      presigned.push({ userId, key });
      return { url: `https://s3.test/${key}?sig=1`, expiresAt: NOW };
    },
    presigned,
  };
}

const NOW = new Date("2026-07-24T00:00:00.000Z");
const OUTPUT_SPEC = {
  width: 1080,
  height: 1920,
  fps: 30,
  aspectRatio: "9:16",
  codec: "h264",
} as const;

function makeService(fake: { prisma: PrismaClient }, seams: any) {
  return new RendersService({
    prisma: fake.prisma,
    enqueue: seams.enqueue,
    cancel: seams.cancel,
    presignDownload: seams.presignDownload,
    now: () => NOW,
    generateId: () => "render-fixed",
  });
}

/** Build the three injected seams, all recording onto `fake.calls`. Takes the fake (not
 *  an optional timeline) so a seam can never be wired up off-timeline by omission. */
function seams(
  fake: { calls: Call[] },
  overrides: Partial<Record<string, any>> = {},
) {
  const enq = makeEnqueueRecorder(fake.calls);
  const can = makeCancelRecorder(fake.calls);
  const pre = makePresignRecorder(fake.calls);
  return {
    enqueue: enq.enqueue,
    cancel: can.cancel,
    presignDownload: pre.presignDownload,
    enqueued: enq.enqueued,
    canceled: can.canceled,
    presigned: pre.presigned,
    ...overrides,
  };
}

const CREATE_REQ = {
  versionId: "ver-1",
  outputSpec: { ...OUTPUT_SPEC },
  runInBackground: true,
};

/** A persisted RenderJob row shaped like Prisma returns it. */
function renderRow(over: Record<string, unknown> = {}) {
  return {
    id: "render-1",
    projectId: "proj-1",
    versionId: "ver-1",
    userId: "user-1",
    status: "encoding",
    framesDone: 100,
    framesTotal: 900,
    ...OUTPUT_SPEC,
    outputAssetKey: null,
    thumbnailAssetKey: null,
    runInBackground: false,
    error: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------- createRender

describe("RendersService.createRender", () => {
  it("U-RS1: a foreign / unknown / soft-deleted project 404s before any write or enqueue", async () => {
    const fake = makeFake({ project: null });
    const s = seams(fake);
    await expect(
      makeService(fake, s).createRender("user-1", "proj-1", CREATE_REQ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // owner + soft-delete scoping, exactly like every other project-scoped surface
    expect(find(fake.calls, "project.findFirst").args.where).toMatchObject({
      id: "proj-1",
      ownerId: "user-1",
      deletedAt: null,
    });
    expect(has(fake.calls, "renderJob.create")).toBe(false);
    expect(s.enqueued).toHaveLength(0);
  });

  it("U-RS2: a versionId that does not belong to that project 404s (uniform denial), nothing created/enqueued", async () => {
    const fake = makeFake({ project: { id: "proj-1" }, version: null });
    const s = seams(fake);
    await expect(
      makeService(fake, s).createRender("user-1", "proj-1", CREATE_REQ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    expect(find(fake.calls, "projectVersion.findFirst").args.where).toMatchObject({
      id: "ver-1",
      projectId: "proj-1",
    });
    expect(has(fake.calls, "renderJob.create")).toBe(false);
    expect(s.enqueued).toHaveLength(0);
  });

  it("U-RS3: writes a queued row with framesTotal 0, the spec mirrored onto the 5 columns, runInBackground verbatim", async () => {
    const fake = makeFake({
      project: { id: "proj-1" },
      version: { id: "ver-1", projectId: "proj-1" },
    });
    const s = seams(fake);
    const result = await makeService(fake, s).createRender(
      "user-1",
      "proj-1",
      CREATE_REQ,
    );

    expect(result).toEqual({ renderJobId: "render-fixed" });
    const data = find(fake.calls, "renderJob.create").args.data;
    expect(data).toMatchObject({
      id: "render-fixed",
      projectId: "proj-1",
      versionId: "ver-1",
      userId: "user-1",
      status: "queued",
      framesDone: 0,
      // D1: the API cannot estimate honestly — the worker writes the real total at
      // bundleComposition. 0 means "indeterminate" to the overlay.
      framesTotal: 0,
      width: 1080,
      height: 1920,
      fps: 30,
      aspectRatio: "9:16",
      codec: "h264",
      // stored as a UI hint ONLY — it must never affect a branch in this service
      runInBackground: true,
    });
  });

  it("U-RS4: enqueues AFTER the write, on the shared render target, with workflowID = renderJobId", async () => {
    const fake = makeFake({
      project: { id: "proj-1" },
      version: { id: "ver-1", projectId: "proj-1" },
    });
    const s = seams(fake);
    await makeService(fake, s).createRender("user-1", "proj-1", CREATE_REQ);

    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0].opts).toEqual({
      workflowName: RENDER_WORKFLOW_NAME,
      queueName: RENDER_QUEUE_NAME,
      workflowID: "render-fixed",
    });
    // the enqueue payload is the shared id-echo contract task 36 consumes
    expect(RenderWorkflowPayloadSchema.parse(s.enqueued[0].payload)).toEqual({
      renderJobId: "render-fixed",
    });

    // ORDERING (the point of this test). `DBOSClient.enqueue` durably records the
    // workflow as ENQUEUED the moment it returns, so a 1-worker `render` queue can pick
    // it up immediately — and the workflow's very first step does `renderJob.findUnique`
    // and classifies a missing row as a PERMANENT failure. The row must therefore be
    // COMMITTED before the enqueue, not merely issued.
    //
    // Both operands live on one shared timeline now; asserting `renderJob.create` was
    // merely PRESENT (as this test used to) passed just as happily when the enqueue came
    // first, which is exactly the regression that would hand the worker a phantom row.
    expect(at(fake.calls, "renderJob.create")).toBeLessThan(
      at(fake.calls, "dbos.enqueue"),
    );
    // ...and because the write is transactional, the COMMIT boundary — not just the
    // statement — has to precede the enqueue.
    expect(at(fake.calls, "$transaction")).toBeLessThan(
      at(fake.calls, "dbos.enqueue"),
    );
  });

  it("U-RS5: sets Project.lastRenderJobId to the new id in the same transaction (D3)", async () => {
    const fake = makeFake({
      project: { id: "proj-1" },
      version: { id: "ver-1", projectId: "proj-1" },
    });
    const s = seams(fake);
    await makeService(fake, s).createRender("user-1", "proj-1", CREATE_REQ);

    const update = find(fake.calls, "project.update");
    expect(update.args.where).toMatchObject({ id: "proj-1" });
    expect(update.args.data).toMatchObject({ lastRenderJobId: "render-fixed" });
    expect(has(fake.calls, "$transaction")).toBe(true);
  });
});

// ------------------------------------------------------------------- getRender

describe("RendersService.getRender / listMyRenders", () => {
  it("U-RS6: getRender scopes directly on RenderJob.userId; a miss/foreign row 404s", async () => {
    const fake = makeFake({ render: null });
    await expect(
      makeService(fake, seams(fake)).getRender("user-1", "render-1"),
    ).rejects.toBeInstanceOf(RenderNotFoundError);
    expect(find(fake.calls, "renderJob.findFirst").args.where).toMatchObject({
      id: "render-1",
      userId: "user-1",
    });

    const ok = makeFake({ render: renderRow() });
    await expect(
      makeService(ok, seams(ok)).getRender("user-1", "render-1"),
    ).resolves.toMatchObject({ id: "render-1" });
  });

  it("U-RS7: listMyRenders filters on the caller and returns newest-first (createdAt desc, id desc tiebreak)", async () => {
    const t = (iso: string) => new Date(iso);
    const fake = makeFake({
      renders: [
        renderRow({ id: "b", createdAt: t("2026-07-24T00:00:00.000Z") }),
        renderRow({ id: "c", createdAt: t("2026-07-25T00:00:00.000Z") }),
        renderRow({ id: "a", createdAt: t("2026-07-24T00:00:00.000Z") }),
      ],
    });
    const rows = await makeService(fake, seams(fake)).listMyRenders("user-1");

    expect(find(fake.calls, "renderJob.findMany").args.where).toMatchObject({
      userId: "user-1",
    });
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

// ---------------------------------------------------------------- cancelRender

describe("RendersService.cancelRender", () => {
  it("U-RS8: cancels the DBOS workflow BEFORE the row write, and flips the row conditionally", async () => {
    const fake = makeFake({
      render: renderRow({ status: "encoding" }),
      reReadRender: renderRow({ status: "canceled", completedAt: NOW }),
    });
    const s = seams(fake);
    const after = await makeService(fake, s).cancelRender("user-1", "render-1");

    expect(s.canceled).toEqual(["render-1"]);

    // ORDERING (the point of this test's title). Stop the COMPUTE first: if
    // `DBOSClient.cancelWorkflow` throws, the row must still read as whatever the
    // still-running workflow is doing — a `canceled` row sitting in front of a live
    // render is a lie the UI cannot recover from. Asserting that both happened (as this
    // test used to) passed identically when the service flipped the row first, which is
    // the exact inversion the design note at renders-service.ts:203-218 exists to prevent.
    expect(at(fake.calls, "dbos.cancel")).toBeLessThan(
      at(fake.calls, "renderJob.updateMany"),
    );

    const upd = find(fake.calls, "renderJob.updateMany").args;
    expect(upd.where.id).toBe("render-1");
    // The race guard, asserted as an EXACT SET. The previous
    // `not.toEqual(arrayContaining([completed, failed, canceled]))` was unsound:
    // `arrayContaining` requires ALL of its members, so the negation passed whenever ANY
    // one was absent — a `where` that wrongly admitted `completed` (but not `failed`)
    // sailed through, and a cancel would then clobber a finished render.
    const CANCELABLE_SORTED = [
      "bundling",
      "encoding",
      "queued",
      "synthesizing",
      "uploading",
    ];
    expect([...upd.where.status.in].sort()).toEqual(CANCELABLE_SORTED);
    // ...and the service's own constant is that same set, so neither the literal above
    // nor the guard the dbos `markRenderCanceled` docstring is written for can drift
    // without this failing.
    expect([...CANCELABLE_RENDER_STATUSES].sort()).toEqual(CANCELABLE_SORTED);
    for (const terminal of ["completed", "failed", "canceled"]) {
      expect(upd.where.status.in).not.toContain(terminal);
    }
    expect(upd.data).toMatchObject({ status: "canceled", completedAt: NOW });
    expect(after.status).toBe("canceled");
  });

  it("U-RS9: a terminal render 409s and never touches DBOS or the row", async () => {
    for (const status of ["completed", "failed", "canceled"]) {
      const fake = makeFake({ render: renderRow({ status }) });
      const s = seams(fake);
      await expect(
        makeService(fake, s).cancelRender("user-1", "render-1"),
      ).rejects.toBeInstanceOf(RenderNotCancelableError);
      expect(s.canceled).toHaveLength(0);
      expect(has(fake.calls, "renderJob.updateMany")).toBe(false);
    }
  });

  it("U-RS10: a render that completes inside the cancel window wins (conditional update matches 0 rows)", async () => {
    const fake = makeFake({
      render: renderRow({ status: "uploading" }),
      updatedCount: 0,
      reReadRender: renderRow({
        status: "completed",
        outputAssetKey: buildRenderOutputKey("render-1"),
        completedAt: NOW,
      }),
    });
    const after = await makeService(fake, seams(fake)).cancelRender("user-1", "render-1");
    expect(after.status).toBe("completed");
  });

  it("U-RS9b: cancel of a missing/foreign render 404s", async () => {
    const fake = makeFake({ render: null });
    await expect(
      makeService(fake, seams(fake)).cancelRender("user-1", "nope"),
    ).rejects.toBeInstanceOf(RenderNotFoundError);
  });
});

// -------------------------------------------------------- presignRenderDownload

describe("RendersService.presignRenderDownload", () => {
  it("U-RS11: a non-completed render, or a completed one with no outputAssetKey, 404s", async () => {
    for (const row of [
      renderRow({ status: "encoding" }),
      renderRow({ status: "failed" }),
      renderRow({ status: "completed", outputAssetKey: null }),
    ]) {
      const fake = makeFake({ render: row });
      const s = seams(fake);
      await expect(
        makeService(fake, s).presignRenderDownload("user-1", "render-1"),
      ).rejects.toBeInstanceOf(RenderNotFoundError);
      expect(s.presigned).toHaveLength(0);
    }
  });

  it("U-RS11b: a completed render delegates to the shared presigner with exactly buildRenderOutputKey(id)", async () => {
    const fake = makeFake({
      render: renderRow({
        status: "completed",
        outputAssetKey: buildRenderOutputKey("render-1"),
        completedAt: NOW,
      }),
    });
    const s = seams(fake);
    const out = await makeService(fake, s).presignRenderDownload(
      "user-1",
      "render-1",
    );

    expect(s.presigned).toEqual([
      { userId: "user-1", key: buildRenderOutputKey("render-1") },
    ]);
    expect(out.url).toContain("renders/render-1/output.mp4");
    expect(out.expiresAt).toEqual(NOW);
  });
});
