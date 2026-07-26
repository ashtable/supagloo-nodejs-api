import type { GalleryItem, GalleryItemDto } from "@supagloo/database-lib";

/**
 * A persisted `GalleryItem` with the owner columns the public card needs. Every read in
 * `GalleryService` asks for exactly this `include`, so the DTO mapper cannot be handed a
 * row that is missing the owner.
 */
export interface GalleryItemRow extends GalleryItem {
  owner: { displayName: string; avatarInitials: string };
}

/** The three facts that are NOT on the row — they are per-request, per-viewer, or signed
 *  at read time — so they are supplied by the service rather than derived here. */
export interface GalleryItemDtoExtras {
  /** Short-lived presigned poster URL; `null` when it could not be signed. */
  thumbnailUrl: string | null;
  /** 1-based global popular ordinal, or `null` under any other sort (plan D11). */
  rank: number | null;
  /** Always `false` for an anonymous viewer (no query is issued at all). */
  viewerHasUpvoted: boolean;
}

/**
 * Map a `GalleryItem` row to the public wire DTO (plan §3.2).
 *
 * Three deliberate omissions, each one an access-control or honesty decision rather than an
 * oversight:
 *   - **`videoAssetKey`** — a public consumer must go through `GET /v1/gallery/:id/
 *     stream-url`; handing out the raw key invites clients to guess sibling keys.
 *   - **`ownerId`** — `owner.{displayName, avatarInitials}` is what the Turn-15 card
 *     renders; exposing an internal user id on a public endpoint is gratuitous. (The
 *     wireframe's `@handle` has no column — `displayName` is the honest stand-in, and that
 *     is a recorded design gap.)
 *   - **`viewCount`** — the column exists, but §8 defines no endpoint that increments or
 *     exposes it, so shipping a field that is always 0 would be a lie. A known gap.
 *
 * `scriptureBook` IS carried: it is the derived USFM code (the FIRST recognized book for a
 * multi-book reference, while `scriptureReference` still renders verbatim). Nothing filters
 * or groups by it — it is an internal column that is free to keep and leaves the door open.
 */
export function toGalleryItemDto(
  row: GalleryItemRow,
  extras: GalleryItemDtoExtras,
): GalleryItemDto {
  return {
    id: row.id,
    renderJobId: row.renderJobId,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    scriptureReference: row.scriptureReference,
    scriptureBook: row.scriptureBook,
    translation: row.translation,
    durationSeconds: row.durationSeconds,
    visibility: row.visibility,
    publishedAt: row.publishedAt.toISOString(),
    upvoteCount: row.upvoteCount,
    thumbnailUrl: extras.thumbnailUrl,
    rank: extras.rank,
    viewerHasUpvoted: extras.viewerHasUpvoted,
    owner: {
      displayName: row.owner.displayName,
      avatarInitials: row.owner.avatarInitials,
    },
  };
}
