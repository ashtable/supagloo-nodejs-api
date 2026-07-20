/**
 * Typed errors for the manifest-read surface (design-delta §5.3/§8). Each carries a
 * `statusCode` the route handler maps to a reply (mirrors `src/projects/errors.ts`).
 *
 * The split (vs the DBOS import-verify side, which collapses missing-file + bad-JSON +
 * schema-mismatch into ONE non-retryable `ManifestInvalidError`) is deliberate: the
 * DBOS classification axis is *retryability*; the HTTP axis is *client semantics*. At
 * the wire, "the file/branch is absent" (retry a different ref; the repo isn't broken)
 * is meaningfully different from "the file is present but its bytes are garbage" (the
 * manifest is corrupt) — so the former is a 404 and the latter a 422.
 */

/**
 * Thrown when the GitHub Contents API returns 404 for `supagloo.project.json` at the
 * requested ref — the repo, the branch/ref, or the file itself does not exist. Maps to
 * **404** (distinct from {@link import("../projects/errors").ProjectNotFoundError},
 * which is about the DB project row, but sharing its not-found status).
 */
export class ManifestNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = "manifest not found") {
    super(message);
    this.name = "ManifestNotFoundError";
  }
}

/**
 * Thrown when `supagloo.project.json` EXISTS but its bytes are not a valid manifest —
 * either not valid JSON, or valid JSON that fails `ProjectManifestSchema`. Both fold
 * together (the content is unprocessable). Maps to **422** (the plan's hard requirement
 * for a corrupted manifest). The API-layer twin of the DBOS import-verify
 * `ManifestInvalidError`.
 */
export class ManifestInvalidError extends Error {
  readonly statusCode = 422;
  constructor(message = "manifest is not a valid supagloo.project.json") {
    super(message);
    this.name = "ManifestInvalidError";
  }
}
