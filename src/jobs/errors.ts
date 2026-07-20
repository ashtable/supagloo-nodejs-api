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
 * workflow yet (import_verify/commit/publish until tasks 19/21/22 wire them). An
 * internal/never-reached condition on the task-18 scaffold-only create path → **500**.
 */
export class UnsupportedJobKindError extends Error {
  readonly statusCode = 500;
  constructor(message = "no workflow is registered for this job kind") {
    super(message);
    this.name = "UnsupportedJobKindError";
  }
}
