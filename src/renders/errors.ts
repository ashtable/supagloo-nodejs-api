/**
 * Typed errors for the render surface (Task #37, design-delta §2.7/§6c/§8). Each carries
 * a `statusCode` the route handler maps to a reply (mirrors `src/ai/errors.ts`). Distinct
 * types → distinct wire `error` codes.
 */

/**
 * Thrown when a render cannot be resolved for the caller. Deliberately covers THREE
 * distinct causes with ONE type + status, following {@link
 * import("../files/errors").FileAccessDeniedError}:
 *   - the id does not exist,
 *   - the row exists but belongs to another user,
 *   - the row exists and is the caller's but has no downloadable output yet
 *     (not `completed`, or `completed` with a null `outputAssetKey`).
 *
 * All map to **404** so the response never distinguishes "not found" from "forbidden"
 * from "not ready". The third case is a 404 and NOT a 409 on purpose: 409 is this
 * codebase's code for a state conflict on a MUTATION (see {@link
 * RenderNotCancelableError}); a GET for an object that does not exist yet is a 404, and
 * `FilesService` would 404 it anyway.
 */
export class RenderNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = "render not found") {
    super(message);
    this.name = "RenderNotFoundError";
  }
}

/**
 * Thrown by `POST /v1/renders/:id/cancel` when the render is already in a TERMINAL state
 * (`completed` / `failed` / `canceled`) — canceling finished work is a client-state
 * conflict. Maps to **409** (`render_not_cancelable`), mirroring
 * {@link import("../ai/errors").GenerationNotCancelableError} and the codebase's
 * 409-for-state-conflict convention.
 */
export class RenderNotCancelableError extends Error {
  readonly statusCode = 409;
  constructor(message = "render is already terminal and cannot be canceled") {
    super(message);
    this.name = "RenderNotCancelableError";
  }
}
