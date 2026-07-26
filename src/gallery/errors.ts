/**
 * Typed errors for the gallery surface (Tasks #39 + #40, design-delta §2.7/§6c/§8). Each
 * carries the `statusCode` its route handler maps to a reply, mirroring
 * `src/renders/errors.ts` and `src/ai/errors.ts`. Distinct types → distinct wire `error`
 * codes, and every status below is justified against this codebase's house vocabulary
 * because a reviewer will (rightly) ask about two of them.
 */

/**
 * A gallery item — or the render being published — could not be resolved FOR THIS CALLER.
 *
 * Deliberately covers several distinct causes with ONE type and ONE status, following
 * {@link import("../files/errors").FileAccessDeniedError}:
 *   - the id does not exist;
 *   - the row exists but belongs to another user (publish and delete are owner-scoped);
 *   - the render id is unknown or foreign at publish time.
 *
 * All map to **404**, so a response never distinguishes "not found" from "forbidden" and
 * existence never leaks. `unlisted` items are NOT hidden by this: they are reachable by
 * link by design (plan D12) — only the LISTING filters them out.
 */
export class GalleryItemNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = "gallery item not found") {
    super(message);
    this.name = "GalleryItemNotFoundError";
  }
}

/**
 * The render exists and is the caller's, but is not in a publishable state: not
 * `completed`, missing `outputAssetKey`/`thumbnailAssetKey`, or `framesTotal === 0` (which
 * means it never reached `bundleComposition`, so it is not really complete and its derived
 * duration would be a lie).
 *
 * Maps to **409** (`render_not_publishable`). WHY 409 HERE WHEN `GET /v1/renders/:id/
 * download` 404s for the same render: this codebase's rule (see `src/renders/errors.ts`)
 * is that **409 is a state conflict on a MUTATION; a GET for an object that does not exist
 * yet is a 404**. Publish is a mutation whose precondition the client can observe and fix
 * by waiting; download is a GET. Both follow the rule, and the rule is why they differ.
 */
export class RenderNotPublishableError extends Error {
  readonly statusCode = 409;
  constructor(message = "render is not publishable") {
    super(message);
    this.name = "RenderNotPublishableError";
  }
}

/**
 * The render already has a gallery item (`GalleryItem.renderJobId` is `@unique`, so this
 * surfaces as a P2002 on insert). Maps to **409** (`already_published`).
 *
 * NOT an idempotent 200: the second call carries a different `title`/`description`/
 * `visibility`, so silently returning 200 would look like the edit took. (Contrast row
 * 40's duplicate vote, which carries no payload and IS a 200 no-op.)
 *
 * `DELETE /v1/gallery/:id` frees the unique slot, so a render can be un-published and
 * re-published.
 */
export class GalleryItemAlreadyPublishedError extends Error {
  readonly statusCode = 409;
  constructor(message = "render is already published to the gallery") {
    super(message);
    this.name = "GalleryItemAlreadyPublishedError";
  }
}

/**
 * `deriveScriptureBook` could not resolve a book code from the client-supplied
 * `scriptureReference`. Maps to **422** (`scripture_book_underivable`), with the offending
 * reference named in the message so the client can fix it.
 *
 * WHY 422 rather than a sentinel or a silent null: `GalleryItem.scriptureBook` is NOT NULL,
 * an `UNKNOWN` sentinel would be junk in a derived column, and dropping the item silently
 * is a worse lie. 422 is this codebase's "semantically invalid, permanently — do not retry"
 * code (`src/ai/errors.ts`), and the reference is client-supplied (plan D7), so it is
 * client-fixable. It cannot be a Zod 400 because the check is a LOOKUP, not a shape.
 */
export class ScriptureBookUnderivableError extends Error {
  readonly statusCode = 422;
  constructor(message = "cannot derive a scripture book from the reference") {
    super(message);
    this.name = "ScriptureBookUnderivableError";
  }
}

/**
 * The `cursor` query parameter did not decode, was structurally invalid, or was minted
 * under a different `sort`. Maps to **400** (`invalid_cursor`).
 *
 * 400 and not 404 because this is a malformed client-supplied PARAMETER and there is no
 * existence to leak. A sort mismatch is an error rather than a silent reset: honouring a
 * `popular` cursor under `sort=newest` would page a DIFFERENT ordering and skip or
 * duplicate large ranges.
 */
export class InvalidGalleryCursorError extends Error {
  readonly statusCode = 400;
  constructor(message = "invalid gallery cursor") {
    super(message);
    this.name = "InvalidGalleryCursorError";
  }
}

/**
 * The `q` search parameter carried a control character or exceeded its length bound. Maps to
 * **400** (`invalid_query`).
 *
 * A SEPARATE type from {@link InvalidGalleryCursorError} even though both are 400s on the
 * same route: the two are fixed by different client changes (drop the cursor vs. fix the
 * search box), and `invalid_cursor` on a request that carried no cursor would send a client
 * looking in the wrong place.
 *
 * WHY THIS EXISTS AT ALL. `GalleryListQuerySchema.q` is a bare `z.string().optional()` in
 * db-lib and `escapeLike` handles only `\ % _`, so nothing stopped a `U+0000`: Postgres
 * cannot carry a NUL in a `text` parameter and `GET /v1/gallery?q=%00` answered
 * `500 … 22021 invalid byte sequence for encoding "UTF8": 0x00` to an anonymous caller — one
 * query parameter, no cursor, no session. The bound is enforced HERE, in the api, because the
 * wire schema lives in another repo; `parseSearchTerm` is its codec-side twin of
 * `parseCursor`.
 */
export class InvalidGallerySearchError extends Error {
  readonly statusCode = 400;
  constructor(message = "invalid gallery search term") {
    super(message);
    this.name = "InvalidGallerySearchError";
  }
}
