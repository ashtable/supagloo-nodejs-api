/**
 * Typed errors for the GitHub connection surface (design-delta §2.3/§8). Each
 * carries a `statusCode` the route handlers map to a reply (mirrors
 * `src/auth/errors.ts`).
 */

/**
 * Thrown when the GitHub App callback cannot verify the supplied installation id
 * (GitHub returned no such installation). The client gave us a bad
 * `installationId`, so routes map it to a `400`.
 */
export class InstallationVerificationError extends Error {
  readonly statusCode = 400;
  constructor(message = "GitHub installation could not be verified") {
    super(message);
    this.name = "InstallationVerificationError";
  }
}

/**
 * Thrown when a per-user GitHub operation (e.g. listing repos) is attempted
 * before the user has connected the GitHub App. Routes map it to a `409` — an
 * account-state precondition the caller must resolve by connecting first.
 */
export class GithubNotConnectedError extends Error {
  readonly statusCode = 409;
  constructor(message = "no GitHub connection for this user") {
    super(message);
    this.name = "GithubNotConnectedError";
  }
}

/**
 * Thrown when the Gloo client-credentials test mint fails (design-delta §2.5 —
 * verify-then-store). The supplied `clientId`/`clientSecret` are invalid, so no row
 * is written and routes map it to a `400` (mirrors {@link InstallationVerificationError}).
 */
export class GlooVerificationError extends Error {
  readonly statusCode = 400;
  constructor(message = "Gloo client credentials could not be verified") {
    super(message);
    this.name = "GlooVerificationError";
  }
}

/**
 * Thrown when the OpenRouter live-credits proxy is attempted before the user has
 * connected OpenRouter. Routes map it to a `409` — an account-state precondition the
 * caller must resolve by connecting first (mirrors {@link GithubNotConnectedError}).
 */
export class OpenRouterNotConnectedError extends Error {
  readonly statusCode = 409;
  constructor(message = "no OpenRouter connection for this user") {
    super(message);
    this.name = "OpenRouterNotConnectedError";
  }
}
