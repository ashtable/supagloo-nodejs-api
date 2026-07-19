/**
 * Typed errors for the projects surface (design-delta §2.6/§8). Carries a
 * `statusCode` the route handler maps to a reply (mirrors `src/files/errors.ts`).
 */

/**
 * Thrown when a project cannot be resolved for the caller. Deliberately covers
 * THREE distinct causes with ONE type + status:
 *   - the project id does not exist,
 *   - it exists but is owned by another user,
 *   - it exists and is owned by the caller but has been soft-deleted (`deletedAt`).
 * All map to **404** so the response never distinguishes "not found" from
 * "forbidden" from "deleted" — a project's existence/ownership must not leak, and a
 * soft-deleted project behaves exactly like one that never existed.
 */
export class ProjectNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = "project not found") {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}
