import { randomUUID } from "node:crypto";
import {
  Prisma,
  isProviderCompatible,
  type AiGeneration,
  type CreateAiGenerationRequest,
  type GenerateScriptPayload,
  type PrismaClient,
} from "@supagloo/database-lib";
import { ProjectNotFoundError } from "../projects/errors";
import {
  AiGenerationNotFoundError,
  GenerationNotCancelableError,
  KindProviderIncompatibleError,
} from "./errors";
import { resolveAiGenerationWorkflow } from "./workflow-lookup";

/** The enqueue arguments: workflow name + queue + the workflowID (= AiGeneration id). */
export interface EnqueueOptions {
  workflowName: string;
  queueName: string;
  workflowID: string;
}

/** Injected enqueue seam — `makeDbosEnqueuer().enqueue` in production, a recorder in unit
 *  tests (so the service never touches a DBOSClient / the system DB directly). */
export type GenerationEnqueue = (
  opts: EnqueueOptions,
  payload: unknown,
) => Promise<void>;

/** Injected cancel seam — `makeDbosEnqueuer().cancel` in production (→
 *  `DBOSClient.cancelWorkflow`), a recorder in unit tests. */
export type GenerationCancel = (workflowID: string) => Promise<void>;

/** Generation statuses that are terminal — no further transition, and not cancelable. */
const TERMINAL_STATUSES = ["succeeded", "failed", "canceled"] as const;
/** Generation statuses that a cancel may flip to `canceled` (the race guard). */
const CANCELABLE_STATUSES = ["queued", "running"] as const;

export interface AiGenerationsServiceOptions {
  prisma: PrismaClient;
  /** Enqueue-only submission to the DBOS system DB (never runs the runtime). */
  enqueue: GenerationEnqueue;
  /** Cancel a running/queued DBOS workflow by id (`DBOSClient.cancelWorkflow`). */
  cancel: GenerationCancel;
  /** Injectable clock for a deterministic `completedAt`. Defaults to wall-clock. */
  now?: () => Date;
  /** Injectable id generator for `AiGeneration.id` (= workflow id); defaults to uuid. */
  generateId?: () => string;
}

/**
 * AI-generation creation + read + cancel (design-delta §2.8/§7/§8). Backs the four Task
 * #31 routes: `POST /v1/ai/generations`, `GET /v1/ai/generations/:id`,
 * `GET /v1/projects/:id/generations`, `POST /v1/ai/generations/:id/cancel`.
 *
 * `AiGeneration.id` IS the DBOS workflow id; the enqueue payload is the minimal
 * `{ generationId }` echo (the workflow reads everything else off the row). A pure DB
 * reader/writer + injected enqueue/cancel seams, so every branch is unit-testable with a
 * fake Prisma + recorders.
 */
export class AiGenerationsService {
  private readonly prisma: PrismaClient;
  private readonly enqueue: GenerationEnqueue;
  private readonly cancel: GenerationCancel;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(opts: AiGenerationsServiceOptions) {
    this.prisma = opts.prisma;
    this.enqueue = opts.enqueue;
    this.cancel = opts.cancel;
    this.now = opts.now ?? (() => new Date());
    this.generateId = opts.generateId ?? (() => randomUUID());
  }

  /**
   * Create an `AiGeneration` row and enqueue its workflow. The two validation gates run
   * BEFORE any row/workflow is created and yield distinct codes:
   *   1. if a `projectId` is given, the caller must own it (else 404 — never attach a
   *      generation to a foreign project, which would leak it into that owner's list);
   *   2. the `{kind, provider}` pair must be in the compatibility matrix (else 422);
   *   3. the kind's workflow must be registered (else 501 for the not-yet-built kinds).
   * Then create the queued row and enqueue AFTER the write (workflowID = generationId; a
   * re-enqueue on the same id is idempotent, so a post-write enqueue failure is a
   * recoverable stuck-`queued` gap, matching the ProjectJob create path).
   */
  async createGeneration(
    userId: string,
    req: CreateAiGenerationRequest,
  ): Promise<{ generationId: string }> {
    if (req.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: req.projectId, ownerId: userId, deletedAt: null },
      });
      if (!project) throw new ProjectNotFoundError();
    }

    if (!isProviderCompatible(req.kind, req.provider)) {
      throw new KindProviderIncompatibleError(
        `provider "${req.provider}" cannot serve generation kind "${req.kind}"`,
      );
    }

    // Resolve the workflow BEFORE creating the row — an unwired (matrix-valid) kind 501s
    // here, so no orphaned row is left behind.
    const { workflowName, queueName } = resolveAiGenerationWorkflow(req.kind);

    const id = this.generateId();
    await this.prisma.aiGeneration.create({
      data: {
        id,
        userId,
        projectId: req.projectId ?? null,
        sceneId: req.sceneId ?? null,
        kind: req.kind,
        provider: req.provider,
        model: req.model,
        input: req.input as unknown as Prisma.InputJsonValue,
        status: "queued",
      },
    });

    const payload: GenerateScriptPayload = { generationId: id };
    // Enqueue AFTER the write (same idempotent-re-enqueue story as ProjectJob: workflowID
    // = generationId, so a re-enqueue attaches to the existing workflow, never double-runs).
    await this.enqueue({ workflowName, queueName, workflowID: id }, payload);

    return { generationId: id };
  }

  /**
   * Resolve a generation scoped DIRECTLY on the caller's `userId` — unlike ProjectJob
   * (scoped via its project), `AiGeneration` has a nullable `projectId`, so project
   * scoping can't cover project-less generations. A missing / foreign generation →
   * {@link AiGenerationNotFoundError} (404, never leaks existence).
   */
  async getGeneration(userId: string, id: string): Promise<AiGeneration> {
    const generation = await this.prisma.aiGeneration.findFirst({
      where: { id, userId },
    });
    if (!generation) throw new AiGenerationNotFoundError();
    return generation;
  }

  /**
   * List a project's generations, newest first (`createdAt` desc, `id` desc tiebreak for
   * determinism). The project is resolved first (owner + soft-delete scoping) so
   * generations of a foreign/deleted project never leak. Unpaginated bounded list
   * (consistent with `listVersions`; design documents no pagination here).
   */
  async listProjectGenerations(
    userId: string,
    projectId: string,
  ): Promise<AiGeneration[]> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId: userId, deletedAt: null },
    });
    if (!project) throw new ProjectNotFoundError();

    const generations = await this.prisma.aiGeneration.findMany({
      where: { projectId },
    });
    return [...generations].sort((a, b) => {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime();
      if (byTime !== 0) return byTime;
      if (a.id === b.id) return 0;
      return a.id < b.id ? 1 : -1; // id descending, stable
    });
  }

  /**
   * Cancel a generation (design-delta §2.8; no explicit AiGeneration cancel spec exists —
   * extrapolated from the render-job precedent + task-30's finding that
   * `generateScriptWorkflow` does NOT write the row on cancel, so the API is authoritative
   * for the domain-row transition):
   *   - resolve owner-scoped (404 on miss);
   *   - a TERMINAL row → 409 (canceling completed work is a state conflict);
   *   - otherwise cancel the DBOS workflow FIRST (stop the compute), then flip the row with
   *     a CONDITIONAL update (only `queued`/`running`), which closes the cancel-vs-complete
   *     race — if the workflow finished and wrote a result in the window, the update matches
   *     0 rows and we do not clobber it. Re-read and return the resulting (honest) state.
   */
  async cancelGeneration(userId: string, id: string): Promise<AiGeneration> {
    const generation = await this.getGeneration(userId, id);
    if ((TERMINAL_STATUSES as readonly string[]).includes(generation.status)) {
      throw new GenerationNotCancelableError();
    }

    // Stop the compute first: a failed cancelWorkflow must not leave a `canceled` row
    // behind a still-running workflow.
    await this.cancel(id);

    // Conditional flip — only a still-cancelable row is touched (race guard).
    await this.prisma.aiGeneration.updateMany({
      where: { id, status: { in: [...CANCELABLE_STATUSES] } },
      data: { status: "canceled", completedAt: this.now() },
    });

    // Return the true post-cancel state (canceled, or the terminal state that won the race).
    const after = await this.prisma.aiGeneration.findFirst({
      where: { id, userId },
    });
    return after ?? generation;
  }
}
