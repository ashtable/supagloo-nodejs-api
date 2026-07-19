/**
 * Typed errors for the files surface (design-delta §4/§8). Carries a `statusCode`
 * the route handler maps to a reply (mirrors `src/connections/errors.ts`).
 */

/**
 * Thrown when a presigned-download request cannot be authorized for the caller.
 * Deliberately covers THREE distinct causes with ONE type + status:
 *   - the requested key is malformed / unrecognized,
 *   - the referenced project/render row does not exist,
 *   - the row exists but is owned by another user.
 * All map to **404** so the response never distinguishes "not found" from
 * "forbidden" — existence of another user's object must not leak.
 */
export class FileAccessDeniedError extends Error {
  readonly statusCode = 404;
  constructor(message = "file not found") {
    super(message);
    this.name = "FileAccessDeniedError";
  }
}
