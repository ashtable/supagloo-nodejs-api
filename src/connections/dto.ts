import type {
  GithubConnection,
  GithubConnectionStatus,
  GlooConnection,
  GlooConnectionStatus,
  OpenRouterConnection,
  OpenRouterConnectionStatus,
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

/**
 * Map a persisted `OpenRouterConnection` row to its wire DTO (design-delta §2.5).
 * Carries ONLY the masked `keyLast4` — never `apiKeyCiphertext`. `connectedAt`
 * becomes an ISO-8601 string.
 */
export function toOpenRouterConnectionDto(
  row: OpenRouterConnection,
): OpenRouterConnectionStatus {
  return {
    keyLast4: row.keyLast4,
    status: row.status,
    connectedAt: row.connectedAt.toISOString(),
  };
}

/**
 * Map a persisted `GlooConnection` row to its wire DTO (design-delta §2.5). Carries
 * the plaintext `clientId` and the timestamps — never `clientSecretCiphertext`.
 * Date columns become ISO-8601 strings.
 */
export function toGlooConnectionDto(
  row: GlooConnection,
): GlooConnectionStatus {
  return {
    clientId: row.clientId,
    status: row.status,
    connectedAt: row.connectedAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt.toISOString(),
  };
}
