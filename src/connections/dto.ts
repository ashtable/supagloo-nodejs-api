import type {
  GithubConnection,
  GithubConnectionStatus,
} from "@supagloo/database-lib";

/**
 * Map a persisted `GithubConnection` row to the `GithubConnectionStatus` wire DTO
 * (design-delta §2.3). `connectedAt` becomes an ISO-8601 string; `userId` is not
 * exposed on the wire (the caller is already the owner). No token field exists —
 * the installation id is the only stored credential-pointer.
 */
export function toGithubConnectionDto(
  row: GithubConnection,
): GithubConnectionStatus {
  return {
    githubLogin: row.githubLogin,
    installationId: row.installationId,
    repositorySelection: row.repositorySelection,
    status: row.status,
    connectedAt: row.connectedAt.toISOString(),
  };
}
