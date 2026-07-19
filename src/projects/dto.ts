import type {
  Project,
  ProjectDto,
  ProjectVersion,
  ProjectVersionDto,
} from "@supagloo/database-lib";

/**
 * Map a persisted `Project` row to the `ProjectDto` wire shape (design-delta §2.6).
 * `lastOpenedAt`/`createdAt` become ISO-8601 strings; `ownerId` and `deletedAt` are
 * NOT exposed (the caller is already the owner; deleted rows are filtered out
 * upstream). Nullable asset keys pass through unchanged.
 */
export function toProjectDto(row: Project): ProjectDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    repoVisibility: row.repoVisibility,
    createdFrom: row.createdFrom,
    currentBranch: row.currentBranch,
    thumbnailAssetKey: row.thumbnailAssetKey,
    lastRenderJobId: row.lastRenderJobId,
    lastOpenedAt: row.lastOpenedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Map a persisted `ProjectVersion` row to the `ProjectVersionDto` wire shape
 * (design-delta §2.6). `publishedAt` becomes an ISO-8601 string (or stays null);
 * `changedFiles` (a Prisma `Json` column) is passed through as the string array the
 * writers (seed + the #21/#22 commit/publish workflows) always store.
 */
export function toProjectVersionDto(row: ProjectVersion): ProjectVersionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    semver: row.semver,
    branchName: row.branchName,
    state: row.state,
    commitMessage: row.commitMessage,
    autoSummary: row.autoSummary,
    changedFiles: row.changedFiles as string[],
    headCommitSha: row.headCommitSha,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}
