/**
 * Typed error for the create-new-repo JIT hop (Task #26, design-delta §2.3/§6b).
 * Carries a `statusCode` the route handler maps to a reply (mirrors
 * `src/projects/errors.ts`).
 */

/**
 * Thrown when the GitHub user-token dance itself fails — the code exchange, the
 * `POST /user/repos` create, the installation-add, or the installation-visibility
 * gate ({@link RepoNotVisibleError}) — as opposed to a
 * precondition (no connection → {@link import("../connections/errors").GithubNotConnectedError})
 * or a duplicate (→ the task-18 create 409s). It is an upstream-provider failure,
 * so routes map it to **502** (`repo_creation_failed`).
 */
export class RepoCreationError extends Error {
  readonly statusCode = 502;
  /**
   * The upstream GitHub HTTP status, when the cause carried one (plan row 63 / D63.5).
   * The reply's status code (**502**) and error slug (`repo_creation_failed`) are
   * contract-pinned and unaffected; this only lets the human-readable message name the
   * real upstream failure instead of collapsing every cause into one opaque 502.
   */
  readonly upstreamStatus?: number;
  constructor(
    message = "failed to create the GitHub repository",
    options?: { cause?: unknown; upstreamStatus?: number },
  ) {
    super(message, options);
    this.name = "RepoCreationError";
    this.upstreamStatus = options?.upstreamStatus;
  }
}

/**
 * The repo WAS created on GitHub, but the App installation never listed it within the
 * gate's window, so the scaffold workflow was never enqueued (DR1).
 *
 * Why this is a hard failure and not a warning: dbos's `ensureRepoReachable`
 * (`scaffold-project/github-rest.ts`) throws `RepoUnreachableError` when the repo is
 * absent from the installation's view, and `isPermanentScaffoldFailure` classifies that
 * as PERMANENT — `shouldRetry` is false, so the step fails on its FIRST attempt with no
 * DBOS retry. Enqueueing anyway would therefore not "probably work out"; it would
 * produce a job that goes straight to `failed` (row 63's `markJobFailed`) next to a
 * real, empty repo the user never asked to keep. Failing HERE is the same outcome
 * without the orphaned job, and with a message that names the actual cause.
 *
 * It **extends {@link RepoCreationError} deliberately**: `POST /v1/projects/create-repo`
 * is contract-pinned to `502 repo_creation_failed`, its response schema declares no
 * other failure status, and the route maps by `instanceof RepoCreationError`. A sibling
 * class would fall through to Fastify's default handler and answer 500 off-contract.
 * The subclass keeps the reply identical and lets the MESSAGE carry the distinction.
 */
export class RepoNotVisibleError extends RepoCreationError {
  /** `owner/name` as GitHub assigned it. */
  readonly repoFullName: string;
  /** The gate's deadline, in ms — what "never became visible" was measured against. */
  readonly timeoutMs: number;
  constructor(opts: {
    repoFullName: string;
    timeoutMs: number;
    installationId: string;
    lastProbeError?: unknown;
    cause?: unknown;
  }) {
    const probeDetail =
      opts.lastProbeError instanceof Error
        ? ` The last listing attempt itself failed: ${opts.lastProbeError.message}`
        : "";
    super(
      `the GitHub repository ${opts.repoFullName} was created, but installation ` +
        `${opts.installationId} still did not list it after ${opts.timeoutMs}ms, so the ` +
        "scaffold workflow was not started (it would have failed permanently on an " +
        "unreachable repo). The repository still exists — retry, or check that the " +
        "Supagloo GitHub App has access to it." +
        probeDetail,
      { cause: opts.cause ?? opts.lastProbeError },
    );
    this.name = "RepoNotVisibleError";
    this.repoFullName = opts.repoFullName;
    this.timeoutMs = opts.timeoutMs;
  }
}
