import { randomUUID } from "node:crypto";
import {
  RENDER_WORKFLOW_TARGET,
  buildRenderOutputKey,
  type CreateRenderRequest,
  type PrismaClient,
  type RenderJob,
  type RenderWorkflowPayload,
} from "@supagloo/database-lib";
import { ProjectNotFoundError } from "../projects/errors";
import { RenderNotCancelableError, RenderNotFoundError } from "./errors";

/** The enqueue arguments: workflow name + queue + the workflowID (= RenderJob id). */
export interface EnqueueOptions {
  workflowName: string;
  queueName: string;
  workflowID: string;
}

/** Injected enqueue seam — `makeDbosEnqueuer().enqueue` in production, a recorder in
 *  unit tests (so the service never touches a DBOSClient / the system DB directly). */
export type RenderEnqueue = (
  opts: EnqueueOptions,
  payload: unknown,
) => Promise<void>;

/** Injected cancel seam — `makeDbosEnqueuer().cancel` in production (→
 *  `DBOSClient.cancelWorkflow`), a recorder in unit tests. */
export type RenderCancel = (workflowID: string) => Promise<void>;

/** Injected presign seam — `FilesService.presignDownload` in production. Keeping this a
 *  function seam means the API has exactly ONE place that talks to AWS signing and ONE
 *  ownership rule for `renders/{id}/…` keys (`FilesService.assertOwnership` already
 *  resolves those to `RenderJob.userId`). */
export type RenderPresignDownload = (
  userId: string,
  key: string,
) => Promise<{ url: string; expiresAt: Date }>;

/** Render statuses that are terminal — no further transition, and not cancelable.
 *  Mirrors the dbos worker's `TERMINAL_RENDER_STATUSES` (render/status.ts). */
const TERMINAL_RENDER_STATUSES = ["completed", "failed", "canceled"] as const;

/** Render statuses a cancel may flip to `canceled` (the race guard). Exactly the
 *  complement of {@link TERMINAL_RENDER_STATUSES}, and exactly the set the dbos
 *  `markRenderCanceled` `updateMany` guard allows — so the two writers agree.
 *
 *  Exported so the unit suite can assert the `where.status.in` set EXACTLY rather than
 *  approximately: this list is the whole race guard, and a single terminal status
 *  leaking into it would let a cancel clobber finished work. */
export const CANCELABLE_RENDER_STATUSES = [
  "queued",
  "synthesizing",
  "bundling",
  "encoding",
  "uploading",
] as const;

export interface RendersServiceOptions {
  prisma: PrismaClient;
  /** Enqueue-only submission to the DBOS system DB (never runs the runtime). */
  enqueue: RenderEnqueue;
  /** Cancel a running/queued DBOS workflow by id (`DBOSClient.cancelWorkflow`). */
  cancel: RenderCancel;
  /** Presign an owned S3 key (delegated to `FilesService` in production). */
  presignDownload: RenderPresignDownload;
  /** Injectable clock for a deterministic `completedAt`. Defaults to wall-clock. */
  now?: () => Date;
  /** Injectable id generator for `RenderJob.id` (= workflow id); defaults to uuid. */
  generateId?: () => string;
}

/**
 * Render creation + read + cancel + download presigning (Task #37, design-delta
 * §2.7/§6c/§8). Backs the five routes: `POST /v1/projects/:id/renders`,
 * `GET /v1/renders/:id`, `POST /v1/renders/:id/cancel`, `GET /v1/renders?mine=1`,
 * `GET /v1/renders/:id/download`.
 *
 * `RenderJob.id` IS the DBOS workflow id (the column has no `@default`, so the API must
 * generate it); the enqueue payload is the minimal `{ renderJobId }` echo — task 36's
 * workflow reads project/version/user/output-spec straight off the row and its relations.
 *
 * A pure DB reader/writer plus injected enqueue/cancel/presign seams, so every branch is
 * unit-testable with a fake Prisma + recorders.
 */
export class RendersService {
  private readonly prisma: PrismaClient;
  private readonly enqueue: RenderEnqueue;
  private readonly cancel: RenderCancel;
  private readonly presign: RenderPresignDownload;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(opts: RendersServiceOptions) {
    this.prisma = opts.prisma;
    this.enqueue = opts.enqueue;
    this.cancel = opts.cancel;
    this.presign = opts.presignDownload;
    this.now = opts.now ?? (() => new Date());
    this.generateId = opts.generateId ?? (() => randomUUID());
  }

  /**
   * Create a `RenderJob` row and enqueue its workflow. Two gates run BEFORE any write:
   *   1. the caller must own the (non-soft-deleted) project — else 404;
   *   2. the `versionId` must belong to THAT project — else 404 (uniform denial: a
   *      version id from someone else's project must not be distinguishable from a
   *      typo, and rendering another project's branch would be a data leak).
   *
   * Then the row + `Project.lastRenderJobId` are written in ONE transaction and the
   * workflow is enqueued AFTER the write. The ordering is load-bearing: the workflow's
   * very first step does `renderJob.findUnique` and classifies a missing row as a
   * PERMANENT failure. A post-write enqueue failure is a recoverable stuck-`queued` gap
   * (a re-enqueue on the same `workflowID` attaches to the existing workflow, never
   * double-runs), matching the ProjectJob / AiGeneration create paths.
   *
   * `framesTotal` is left at the column default 0. The API has no composition knowledge
   * (the manifest lives in the project's GitHub repo), so it cannot estimate honestly;
   * the worker writes the authoritative total at `bundleComposition`, and the 14c overlay
   * reads `framesTotal === 0` as "indeterminate".
   */
  async createRender(
    userId: string,
    projectId: string,
    req: CreateRenderRequest,
  ): Promise<{ renderJobId: string }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId: userId, deletedAt: null },
    });
    if (!project) throw new ProjectNotFoundError();

    const version = await this.prisma.projectVersion.findFirst({
      where: { id: req.versionId, projectId },
    });
    if (!version) throw new ProjectNotFoundError("project version not found");

    const id = this.generateId();
    const { width, height, fps, aspectRatio, codec } = req.outputSpec;

    await this.prisma.$transaction([
      this.prisma.renderJob.create({
        data: {
          id,
          projectId,
          versionId: req.versionId,
          userId,
          status: "queued",
          framesDone: 0,
          framesTotal: 0,
          width,
          height,
          fps,
          aspectRatio,
          codec,
          // A UI hint ONLY (design §2.7) — the job is always async server-side, and
          // nothing in this service or the worker branches on it.
          runInBackground: req.runInBackground,
        },
      }),
      // design-delta §2.6: `lastRenderJobId` drives the 10a RENDERED/DRAFT badge. The API
      // is the only writer that can set it without a dbos change, and "the last render
      // job" is literally true from creation. (Propagating the render's
      // `thumbnailAssetKey` onto the Project at COMPLETION is a follow-up — only the
      // worker knows that, and only when the render finishes.)
      this.prisma.project.update({
        where: { id: projectId },
        data: { lastRenderJobId: id },
      }),
    ]);

    const payload: RenderWorkflowPayload = { renderJobId: id };
    await this.enqueue({ ...RENDER_WORKFLOW_TARGET, workflowID: id }, payload);

    return { renderJobId: id };
  }

  /**
   * Resolve a render scoped DIRECTLY on the caller's `userId` — `RenderJob` carries its
   * own `userId`, so there is no need to hop through the project (and a render of a
   * since-deleted project stays readable by its owner). A missing / foreign render →
   * {@link RenderNotFoundError} (404, never leaks existence).
   */
  async getRender(userId: string, id: string): Promise<RenderJob> {
    const render = await this.prisma.renderJob.findFirst({
      where: { id, userId },
    });
    if (!render) throw new RenderNotFoundError();
    return render;
  }

  /**
   * The caller's renders, newest first (`createdAt` desc, `id` desc tiebreak for
   * determinism) — backs `GET /v1/renders?mine=1` ("Your videos", Turn 15 / task 41).
   * Unpaginated bounded list, consistent with `listVersions` / `listProjectGenerations`;
   * the `@@index([userId])` on RenderJob is what makes it cheap.
   */
  async listMyRenders(userId: string): Promise<RenderJob[]> {
    const renders = await this.prisma.renderJob.findMany({ where: { userId } });
    return [...renders].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) return byTime;
      if (a.id === b.id) return 0;
      return a.id < b.id ? 1 : -1; // id descending, stable
    });
  }

  /**
   * Cancel a render (design-delta §8). Task 36's `markRenderCanceled` docstring is
   * written FOR this endpoint: both writers make the same conditional write, and neither
   * may clobber a row that has already reached a terminal state.
   *   - resolve owner-scoped (404 on miss);
   *   - a TERMINAL row → 409 (canceling finished work is a state conflict);
   *   - otherwise cancel the DBOS workflow FIRST — a failed `cancelWorkflow` must not
   *     leave a `canceled` row behind a still-running render — then flip the row with a
   *     CONDITIONAL update (only the five non-terminal statuses), which closes the
   *     cancel-vs-complete race: if the render finished in the window the update matches
   *     0 rows and we do not clobber it. Re-read and return the honest resulting state.
   *
   * DBOS preempts the workflow at its next step boundary, so the worker's own
   * `markRenderCanceled` may land seconds later; this conditional write is what makes
   * cancel feel immediate in the overlay, and the two writes are idempotent w.r.t. each
   * other.
   */
  async cancelRender(userId: string, id: string): Promise<RenderJob> {
    const render = await this.getRender(userId, id);
    if ((TERMINAL_RENDER_STATUSES as readonly string[]).includes(render.status)) {
      throw new RenderNotCancelableError();
    }

    await this.cancel(id);

    await this.prisma.renderJob.updateMany({
      where: { id, status: { in: [...CANCELABLE_RENDER_STATUSES] } },
      data: { status: "canceled", completedAt: this.now() },
    });

    const after = await this.prisma.renderJob.findFirst({ where: { id, userId } });
    return after ?? render;
  }

  /**
   * Presign the render's output for its owner (`GET /v1/renders/:id/download`). A thin,
   * render-aware wrapper over the SAME signer the generic
   * `GET /v1/files/presign-download` uses — the client should not need to know the S3 key
   * layout to download its own render, and only a render-aware route can require the
   * output to actually exist.
   *
   * A render that is not `completed`, or is completed with no `outputAssetKey`, surfaces
   * as {@link RenderNotFoundError} (404) — the object genuinely does not exist yet.
   */
  async presignRenderDownload(
    userId: string,
    id: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const render = await this.getRender(userId, id);
    if (render.status !== "completed" || !render.outputAssetKey) {
      throw new RenderNotFoundError("render output is not available");
    }
    // Recompute from the shared key helper rather than trusting the stored string, so the
    // presigned key always matches the layout `parseS3Key` (and therefore the ownership
    // check) understands.
    return this.presign(userId, buildRenderOutputKey(render.id));
  }
}
