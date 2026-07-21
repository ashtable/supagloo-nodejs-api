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
  constructor(message = "failed to create the GitHub repository", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepoCreationError";
  }
}
