import {
  JobStagesSchema,
  type ProjectJob,
  type ProjectJobDto,
} from "@supagloo/database-lib";

/**
 * Map a persisted `ProjectJob` row to the `ProjectJobDto` polling wire shape
 * (design-delta §2.9/§6b). `createdAt`/`completedAt` become ISO-8601 strings (or
 * `completedAt` stays null); the untyped `Json` `stages` column is VALIDATED via the
 * shared `JobStagesSchema` (defensive — the DBOS worker writes it) and passed through
 * as `{key,label,state}[]`. `error` passes through nullable.
 */
export function toProjectJobDto(row: ProjectJob): ProjectJobDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    stages: JobStagesSchema.parse(row.stages),
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
