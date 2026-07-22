import type { AiGeneration, AiGenerationDto } from "@supagloo/database-lib";

/**
 * Map a persisted `AiGeneration` row to the `AiGenerationDto` wire shape (design-delta
 * §2.8). `createdAt`/`completedAt` become ISO-8601 strings (or `completedAt` stays null);
 * `resultJson`/`tokenUsage` are pass-through JSON (their shape varies by kind and was
 * validated by the workflow when written). Omits `userId` (the caller is the owner),
 * `providerJobId` (internal), and `input` (a lean status+result view). `resultAssetKey` is
 * surfaced as the RAW key — the client presigns it via `GET /v1/files/presign-download`.
 */
export function toAiGenerationDto(row: AiGeneration): AiGenerationDto {
  return {
    id: row.id,
    projectId: row.projectId,
    sceneId: row.sceneId,
    kind: row.kind,
    provider: row.provider,
    model: row.model,
    status: row.status,
    resultJson: row.resultJson ?? null,
    resultAssetKey: row.resultAssetKey,
    error: row.error,
    tokenUsage: row.tokenUsage ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
