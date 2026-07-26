/**
 * Typed error for the create-new-repo JIT hop (Task #26, design-delta §2.3/§6b).
 * Carries a `statusCode` the route handler maps to a reply (mirrors
 * `src/projects/errors.ts`).
 */

/**
 * Thrown when the GitHub user-token dance itself fails — the code exchange, the
 * `POST /user/repos` create, or the installation-add — as opposed to a
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
