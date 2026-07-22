/**
 * Typed errors for the project job-creation + polling surface (design-delta
 * §5.1/§6b/§8). Each carries a `statusCode` the route handler maps to a reply
 * (mirrors `src/projects/errors.ts`). Distinct types → distinct wire `error` codes so
 * the THREE different 409s on `POST /v1/projects` (no GitHub connection / in-flight
 * git-ops job / already-scaffolded repo) are distinguishable by API consumers.
 */

/**
 * Thrown when a new git-ops job is requested for a project that already has a
 * `queued` or `running` ProjectJob (design-delta §7 concurrency guard). Terminal-state
 * jobs never block. Maps to **409** (`git_ops_in_flight`). Reusable across the later
 * git-ops-enqueuing endpoints (import_verify/commit/publish — tasks 19/21/22).
 */
export class GitOpsInFlightError extends Error {
  readonly statusCode = 409;
  constructor(
    message = "a git-ops job is already in flight for this project",
  ) {
    super(message);
    this.name = "GitOpsInFlightError";
  }
}

/**
 * Thrown when a create is attempted for a repo that already has a (non-deleted)
 * Supagloo project whose jobs are all terminal — one repo maps to one project, so a
 * duplicate create is rejected rather than double-scaffolded. Maps to **409**
 * (`project_exists`).
 */
export class ProjectAlreadyExistsError extends Error {
  readonly statusCode = 409;
  constructor(message = "a project already exists for this repository") {
    super(message);
    this.name = "ProjectAlreadyExistsError";
  }
}

/**
 * Thrown when a job cannot be resolved for the caller's (already owner-scoped)
 * project — the job id does not exist or belongs to a different project. Maps to
 * **404** (never leaks existence; mirrors {@link import("../projects/errors").ProjectNotFoundError}).
 */
export class ProjectJobNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = "project job not found") {
    super(message);
    this.name = "ProjectJobNotFoundError";
  }
}

/**
 * Thrown when `POST /v1/projects` is called with `createdFrom = "import"` — importing
 * an existing project uses the task-19 `import_verify` workflow, NOT scaffolding
 * (scaffolding would overwrite the repo being imported). Maps to **400**.
 */
export class UnsupportedCreatedFromError extends Error {
  readonly statusCode = 400;
  constructor(
    message = 'createdFrom "import" is not handled by project scaffolding',
  ) {
    super(message);
    this.name = "UnsupportedCreatedFromError";
  }
}

/**
 * Thrown by the static enqueue lookup when a `ProjectJobKind` has no registered
 * workflow. All four real git-ops kinds (scaffold/import_verify/commit/publish) are wired,
 * so this is a defensive guard for an unknown kind — an internal/never-reached condition on
 * the wired create paths → **500**.
 */
export class UnsupportedJobKindError extends Error {
  readonly statusCode = 500;
  constructor(message = "no workflow is registered for this job kind") {
    super(message);
    this.name = "UnsupportedJobKindError";
  }
}

/**
 * Thrown by `POST /v1/projects/:id/commit` when the request body's `manifest` is present
 * but does not satisfy `ProjectManifestSchema` (e.g. an empty translation). The
 * API-boundary defensive gate (the route's Zod body schema 400s the same case for HTTP
 * callers; this typed error is the service's own guard for non-HTTP callers). Maps to
 * **422** — the manifest is unprocessable — mirroring the manifest-read
 * {@link import("../manifests/errors").ManifestInvalidError}.
 */
export class CommitManifestInvalidError extends Error {
  readonly statusCode = 422;
  constructor(message = "manifest is not a valid supagloo.project.json") {
    super(message);
    this.name = "CommitManifestInvalidError";
  }
}

/**
 * Thrown by `POST /v1/projects/:id/commit` when the project has no working
 * `ProjectVersion` on its current branch — it is not in a committable state (a scaffolded
 * or imported project always has one, so this is a precondition/consistency guard). Maps
 * to **409** (`no_working_version`).
 */
export class NoWorkingVersionError extends Error {
  readonly statusCode = 409;
  constructor(message = "project has no working version to commit to") {
    super(message);
    this.name = "NoWorkingVersionError";
  }
}
