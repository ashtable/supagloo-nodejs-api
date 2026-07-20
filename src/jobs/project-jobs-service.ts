import { randomUUID } from "node:crypto";
import {
  COMMIT_STAGES,
  IMPORT_STAGES,
  Prisma,
  ProjectManifestSchema,
  SCAFFOLD_STAGES,
  buildBlankManifest,
  buildInitialStages,
  type CommitVersionPayload,
  type CommitVersionRequest,
  type CreateProjectRequest,
  type ImportProjectPayload,
  type ImportProjectRequest,
  type PrismaClient,
  type ProjectJob,
  type ScaffoldProjectPayload,
} from "@supagloo/database-lib";
import { GithubNotConnectedError } from "../connections/errors";
import { ProjectNotFoundError } from "../projects/errors";
import {
  CommitManifestInvalidError,
  GitOpsInFlightError,
  NoWorkingVersionError,
  ProjectAlreadyExistsError,
  ProjectJobNotFoundError,
  UnsupportedCreatedFromError,
} from "./errors";
import { resolveGitOpsWorkflow } from "./workflow-lookup";
import { nextFreeSlug, slugify } from "./slug";

/** The enqueue arguments: workflow name + queue + the workflowID (= ProjectJob id). */
export interface EnqueueOptions {
  workflowName: string;
  queueName: string;
  workflowID: string;
}

/** Injected enqueue seam — `makeDbosEnqueuer` in production, a recorder in unit tests
 *  (so the service never touches a DBOSClient / the system DB directly). */
export type JobEnqueue = (
  opts: EnqueueOptions,
  payload: unknown,
) => Promise<void>;

/** ProjectJob statuses that block a NEW git-ops job (design-delta §7). */
const IN_FLIGHT_STATUSES = ["queued", "running"] as const;

export interface ProjectJobsServiceOptions {
  prisma: PrismaClient;
  /** Enqueue-only submission to the DBOS system DB (never runs the runtime). */
  enqueue: JobEnqueue;
  /** Injectable clock (reserved for future job timestamps); defaults to wall-clock. */
  now?: () => Date;
  /** Injectable id generator for `ProjectJob.id` (= workflow id); defaults to uuid. */
  generateJobId?: () => string;
}

/**
 * Project creation + scaffold enqueue + job polling (design-delta §5.1/§6b/§7/§8).
 * Backs the two Task #18 routes: `POST /v1/projects` and
 * `GET /v1/projects/:id/jobs/:jobId`.
 *
 * The create path (all one owner-scoped orchestration):
 *   1. reject `createdFrom = import` (that is the task-19 import flow, not scaffold);
 *   2. require a GitHub connection (the scaffold workflow mints an installation token
 *      from it) — else {@link GithubNotConnectedError} (409, distinct from the git-ops
 *      409 below);
 *   3. dedup one-repo-one-project on `(ownerId, repoOwner, repoName)`: an existing
 *      project with an in-flight job → {@link GitOpsInFlightError} (409); otherwise a
 *      terminal-only existing project → {@link ProjectAlreadyExistsError} (409) — so a
 *      duplicate POST never double-creates/double-enqueues;
 *   4. derive a free per-owner slug, then create Project + queued ProjectJob (with the
 *      seeded stage log) in ONE transaction;
 *   5. enqueue `scaffoldProject` on `git-ops` with `workflowID = jobId` AFTER commit.
 *
 * A pure DB reader/writer + injected enqueue seam, so every branch is unit-testable
 * with a fake Prisma + a recorder enqueue.
 */
export class ProjectJobsService {
  private readonly prisma: PrismaClient;
  private readonly enqueue: JobEnqueue;
  private readonly now: () => Date;
  private readonly generateJobId: () => string;

  constructor(opts: ProjectJobsServiceOptions) {
    this.prisma = opts.prisma;
    this.enqueue = opts.enqueue;
    this.now = opts.now ?? (() => new Date());
    this.generateJobId = opts.generateJobId ?? (() => randomUUID());
  }

  async createProjectWithScaffold(
    userId: string,
    req: CreateProjectRequest,
  ): Promise<{ projectId: string; jobId: string }> {
    // `import` is a DIFFERENT flow (task-19 import_verify), never scaffolded here.
    if (req.createdFrom === "import") {
      throw new UnsupportedCreatedFromError();
    }

    // The scaffold workflow mints an installation token from the user's connection.
    const connection = await this.prisma.githubConnection.findUnique({
      where: { userId },
    });
    if (!connection) throw new GithubNotConnectedError();

    // One repo ↔ one project. A non-deleted project already pointing at this repo →
    // either it is busy (409 git_ops_in_flight) or it already exists (409
    // project_exists). Either way we never double-create or double-enqueue.
    const existing = await this.prisma.project.findFirst({
      where: {
        ownerId: userId,
        repoOwner: req.repoOwner,
        repoName: req.repoName,
        deletedAt: null,
      },
    });
    if (existing) {
      await this.assertNoInFlightGitOps(existing.id);
      throw new ProjectAlreadyExistsError();
    }

    // Free per-owner slug derived from the repo name (suffix on cross-repo collision).
    // Considers ALL of the owner's projects (incl. soft-deleted) — the unique
    // constraint ignores `deletedAt`.
    const owned = await this.prisma.project.findMany({
      where: { ownerId: userId },
      select: { slug: true },
    });
    const slug = nextFreeSlug(
      new Set(owned.map((p) => p.slug)),
      slugify(req.repoName),
    );

    const name = req.name ?? req.repoName;
    const jobId = this.generateJobId();
    const manifest = buildBlankManifest();
    const stages = buildInitialStages(SCAFFOLD_STAGES);

    const { projectId } = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          slug,
          ownerId: userId,
          name,
          repoOwner: req.repoOwner,
          repoName: req.repoName,
          repoVisibility: req.visibility,
          createdFrom: req.createdFrom,
          currentBranch: "main", // pre-scaffold; the workflow advances it to v0.0.1
        },
      });
      await tx.projectJob.create({
        data: {
          id: jobId,
          projectId: project.id,
          userId,
          kind: "scaffold",
          status: "queued",
          stages: stages as unknown as Prisma.InputJsonValue,
        },
      });
      return { projectId: project.id };
    });

    const { workflowName, queueName } = resolveGitOpsWorkflow("scaffold");
    const payload: ScaffoldProjectPayload = {
      projectId,
      userId,
      ownerId: userId,
      installationId: connection.installationId,
      repoOwner: req.repoOwner,
      repoName: req.repoName,
      repoVisibility: req.visibility,
      createdFrom: req.createdFrom,
      slug,
      name,
      manifest,
    };
    // Enqueue AFTER the transaction commits. If this throws, the ProjectJob is left
    // `queued` with no running workflow; a re-enqueue with the same workflowID (=
    // jobId) is idempotent (DBOS attaches to the id) — an acceptable, documented gap.
    await this.enqueue({ workflowName, queueName, workflowID: jobId }, payload);

    return { projectId, jobId };
  }

  /**
   * Create a Project + `import_verify` ProjectJob for an EXISTING repo and enqueue the
   * `importProject` workflow (design-delta §7 workflow 2 / §8). A sibling of
   * {@link createProjectWithScaffold}: it reuses the SAME connection check, one-repo-one-
   * project dedup + reusable 409 guard, per-owner slug, transaction, and enqueue-after-
   * commit shape — but there is NO `createdFrom` rejection (import IS the import path),
   * NO manifest build (the workflow reads the manifest from the cloned repo), and the
   * job kind is `import_verify` with the `IMPORT_STAGES` catalogue. `createdFrom` is
   * fixed to `import`; the working branch is discovered by the workflow, so the Project
   * is created on the repo default branch (`main`) until it finalizes.
   */
  async createProjectFromImport(
    userId: string,
    req: ImportProjectRequest,
  ): Promise<{ projectId: string; jobId: string }> {
    // The import workflow mints an installation token from the user's connection.
    const connection = await this.prisma.githubConnection.findUnique({
      where: { userId },
    });
    if (!connection) throw new GithubNotConnectedError();

    // One repo ↔ one project — same dedup as scaffold (in-flight → 409 git_ops_in_flight;
    // terminal-only → 409 project_exists), so a duplicate import never double-enqueues.
    const existing = await this.prisma.project.findFirst({
      where: {
        ownerId: userId,
        repoOwner: req.repoOwner,
        repoName: req.repoName,
        deletedAt: null,
      },
    });
    if (existing) {
      await this.assertNoInFlightGitOps(existing.id);
      throw new ProjectAlreadyExistsError();
    }

    const owned = await this.prisma.project.findMany({
      where: { ownerId: userId },
      select: { slug: true },
    });
    const slug = nextFreeSlug(
      new Set(owned.map((p) => p.slug)),
      slugify(req.repoName),
    );

    const name = req.name ?? req.repoName;
    const jobId = this.generateJobId();
    const stages = buildInitialStages(IMPORT_STAGES);

    const { projectId } = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          slug,
          ownerId: userId,
          name,
          repoOwner: req.repoOwner,
          repoName: req.repoName,
          repoVisibility: req.visibility,
          createdFrom: "import",
          currentBranch: "main", // the workflow advances it to the resolved version branch
        },
      });
      await tx.projectJob.create({
        data: {
          id: jobId,
          projectId: project.id,
          userId,
          kind: "import_verify",
          status: "queued",
          stages: stages as unknown as Prisma.InputJsonValue,
        },
      });
      return { projectId: project.id };
    });

    const { workflowName, queueName } = resolveGitOpsWorkflow("import_verify");
    const payload: ImportProjectPayload = {
      projectId,
      userId,
      ownerId: userId,
      installationId: connection.installationId,
      repoOwner: req.repoOwner,
      repoName: req.repoName,
      repoVisibility: req.visibility,
      slug,
      name,
    };
    // Enqueue AFTER commit (same idempotent-re-enqueue story as scaffold: workflowID =
    // jobId, so a re-enqueue attaches to the existing workflow, never double-runs).
    await this.enqueue({ workflowName, queueName, workflowID: jobId }, payload);

    return { projectId, jobId };
  }

  /**
   * Create a `commit` ProjectJob for an EXISTING project's working branch and enqueue the
   * `commitVersion` workflow (design-delta §7 workflow 3 / §8). Unlike scaffold/import
   * (which CREATE a project), commit resolves the existing owner-scoped project + its
   * working `ProjectVersion`, validates the edited manifest at the boundary, and enqueues
   * everything the workflow needs (branch + working semver + manifest + message) so it
   * updates that working version in place. No transaction — only ONE row (the job) is
   * created.
   *
   * @throws {ProjectNotFoundError} (404) project missing / foreign / soft-deleted.
   * @throws {CommitManifestInvalidError} (422) the manifest is not a valid
   *   `ProjectManifestSchema` value (e.g. a non-KJV/BSB translation).
   * @throws {GithubNotConnectedError} (409) the owner has no GitHub connection.
   * @throws {NoWorkingVersionError} (409) the project has no working version to commit to.
   * @throws {GitOpsInFlightError} (409) another git-ops job is already in flight.
   */
  async createCommitJob(
    userId: string,
    projectId: string,
    req: CommitVersionRequest,
  ): Promise<{ jobId: string }> {
    // Owner + soft-delete scoping (404). Also proves the caller is the owner, so the
    // connection lookup below can key off the caller's userId.
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId: userId, deletedAt: null },
    });
    if (!project) throw new ProjectNotFoundError();

    // Boundary manifest validation (defensive; the route's Zod body schema 400s the same
    // case for HTTP callers). A non-KJV/BSB manifest fails here → 422, no writes.
    const parsedManifest = ProjectManifestSchema.safeParse(req.manifest);
    if (!parsedManifest.success) throw new CommitManifestInvalidError();

    // The commit workflow mints an installation token from the user's connection.
    const connection = await this.prisma.githubConnection.findUnique({
      where: { userId },
    });
    if (!connection) throw new GithubNotConnectedError();

    // The working version on the project's current branch — its semver keys the
    // workflow's `updateVersionRecord` upsert (commit updates it in place).
    const workingVersion = await this.prisma.projectVersion.findFirst({
      where: { projectId: project.id, branchName: project.currentBranch },
    });
    if (!workingVersion) throw new NoWorkingVersionError();

    // Serialize per project: reject if a git-ops job is already in flight (409).
    await this.assertNoInFlightGitOps(project.id);

    const jobId = this.generateJobId();
    const stages = buildInitialStages(COMMIT_STAGES);
    await this.prisma.projectJob.create({
      data: {
        id: jobId,
        projectId: project.id,
        userId,
        kind: "commit",
        status: "queued",
        stages: stages as unknown as Prisma.InputJsonValue,
      },
    });

    const { workflowName, queueName } = resolveGitOpsWorkflow("commit");
    const payload: CommitVersionPayload = {
      projectId: project.id,
      userId,
      installationId: connection.installationId,
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      branchName: project.currentBranch,
      semver: workingVersion.semver,
      manifest: parsedManifest.data,
      message: req.message,
    };
    // Enqueue AFTER the write (same idempotent-re-enqueue story: workflowID = jobId).
    await this.enqueue({ workflowName, queueName, workflowID: jobId }, payload);

    return { jobId };
  }

  /**
   * The reusable git-ops concurrency guard (design-delta §7): throw
   * {@link GitOpsInFlightError} when the project has a `queued`/`running` ProjectJob
   * (any kind). Terminal states never block. Reused by the later git-ops-enqueuing
   * endpoints (tasks 19/21/22).
   */
  async assertNoInFlightGitOps(projectId: string): Promise<void> {
    const inFlight = await this.prisma.projectJob.findMany({
      where: { projectId, status: { in: [...IN_FLIGHT_STATUSES] } },
    });
    if (inFlight.length > 0) throw new GitOpsInFlightError();
  }

  /**
   * Resolve a job scoped to the caller's project. The project is resolved first (owner
   * + soft-delete scoping) so a foreign/deleted project's jobs never leak
   * ({@link ProjectNotFoundError}); a missing / wrong-project job →
   * {@link ProjectJobNotFoundError}. Both surface as 404.
   */
  async getJob(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<ProjectJob> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId: userId, deletedAt: null },
    });
    if (!project) throw new ProjectNotFoundError();

    const job = await this.prisma.projectJob.findFirst({
      where: { id: jobId, projectId },
    });
    if (!job) throw new ProjectJobNotFoundError();
    return job;
  }
}
