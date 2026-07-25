import type { RenderJob, RenderJobDto } from "@supagloo/database-lib";

/**
 * Map a persisted `RenderJob` row to the `RenderJobDto` wire shape (Task #37,
 * design-delta §2.7). `createdAt`/`startedAt`/`completedAt` become ISO-8601 strings;
 * the asset keys are surfaced RAW (the client gets a URL from
 * `GET /v1/renders/:id/download`, or presigns the key itself via
 * `GET /v1/files/presign-download`), so this stays a pure projection with no S3 coupling.
 *
 * Two deliberate shape changes from the row:
 *   - `userId` is dropped — the caller is always the owner (connection-DTO precedent);
 *   - the five flat spec COLUMNS (width/height/fps/aspectRatio/codec, design §2.7) are
 *     re-nested into one `outputSpec`, so the request body and this response carry the
 *     SAME `RenderOutputSpecSchema` object and cannot drift.
 */
export function toRenderJobDto(row: RenderJob): RenderJobDto {
  return {
    id: row.id,
    projectId: row.projectId,
    versionId: row.versionId,
    status: row.status,
    framesDone: row.framesDone,
    framesTotal: row.framesTotal,
    outputSpec: {
      width: row.width,
      height: row.height,
      fps: row.fps,
      aspectRatio: row.aspectRatio,
      codec: row.codec,
    },
    outputAssetKey: row.outputAssetKey,
    thumbnailAssetKey: row.thumbnailAssetKey,
    runInBackground: row.runInBackground,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
