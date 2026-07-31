/**
 * Typed errors for the AI-generation surface (design-delta §2.8/§7/§8). Each carries a
 * `statusCode` the route handler maps to a reply (mirrors `src/jobs/errors.ts`). Distinct
 * types → distinct wire `error` codes.
 */

/**
 * Thrown when a `{kind, provider}` pair is outside the shared compatibility matrix
 * (`AI_PROVIDERS_BY_KIND`) — e.g. `narration`+`gloo`. A permanent CLIENT error (the pair
 * can never be valid). Maps to **422** (`kind_provider_incompatible`); enforced BEFORE any
 * row or workflow is created.
 *
 * The example used to be `image`+`gloo` "because Gloo has no media modalities". That was
 * measured false on 2026-07-28 and reversed by decision D1: Gloo generates images via
 * `POST /ai/v2/responses`, and the matrix's `image` row now carries both providers. The
 * three remaining media kinds are the genuine examples — Gloo publishes zero
 * audio/speech/music/video models and those routes answer 404 (absent), not 405.
 */
export class KindProviderIncompatibleError extends Error {
  readonly statusCode = 422;
  constructor(message = "this provider cannot serve this generation kind") {
    super(message);
    this.name = "KindProviderIncompatibleError";
  }
}

/**
 * Thrown when a `kind` is matrix-VALID but its workflow is not registered yet. **No kind
 * reaches this today** — tasks #32–34 wired `image`, `narration`, `music` and `video`, so
 * `AI_GENERATION_WORKFLOW_BY_KIND` now covers all six. It is retained because the map is
 * declared `Partial<Record<…>>`: the type still permits an unregistered kind, so removing
 * the guard would turn a future half-wired kind into a 500 instead of an honest 501. This
 * is a REACHABLE-by-construction server-capability gap, NOT a client error and NOT a
 * crash, so it maps to **501** (`generation_kind_unsupported`) — deliberately distinct
 * from the git-ops
 * {@link import("../jobs/errors").UnsupportedJobKindError} (500), which is a truly
 * unreachable defensive guard because all git-ops kinds are wired. Distinct from the 422
 * matrix rejection above.
 */
export class UnsupportedGenerationKindError extends Error {
  readonly statusCode = 501;
  constructor(message = "no workflow is registered for this generation kind yet") {
    super(message);
    this.name = "UnsupportedGenerationKindError";
  }
}

/**
 * Thrown when the request's `provider` is matrix-VALID for the kind but the caller has not
 * connected it. Maps to **409** (`provider_not_connected`), matching the existing
 * `GithubNotConnectedError` / `OpenRouterNotConnectedError` precedent in
 * `src/connections/errors.ts`.
 *
 * ── Why this is a distinct class from the 422, and why it exists at all ──────────────
 *
 * Before 2026-07-31 this path had no connection check anywhere. `{kind:"narration",
 * provider:"openrouter"}` from a user with no `OpenRouterConnection` is in the matrix, so
 * the 422 never fired: the api answered 201, wrote an `AiGeneration` row, enqueued a
 * workflow, and the request died minutes later inside DBOS at credential-decrypt time. The
 * user saw a spinner and then a generic failure — a greyed-out control in the Studio was
 * still accepted by the server, which is the dishonesty R5/R7 exist to remove.
 *
 * It must NOT be folded into the 422. The two refusals need different words:
 *   · **422** — this pair can NEVER work (Gloo publishes zero speech models). Nothing the
 *     user can do; "connect Gloo and retry" would be advice that cannot succeed.
 *   · **409** — connect this account and try again. Recoverable, and the message names
 *     which account.
 * The gate therefore runs AFTER the matrix check, so a permanently-impossible pair keeps
 * answering 422 even for a user connected to nothing.
 */
export class ProviderNotConnectedError extends Error {
  readonly statusCode = 409;
  constructor(message = "this provider is not connected for this user") {
    super(message);
    this.name = "ProviderNotConnectedError";
  }
}

/**
 * Thrown when a generation cannot be resolved for the caller — the id does not exist or
 * belongs to a different user. Maps to **404** (never leaks existence; mirrors
 * {@link import("../jobs/errors").ProjectJobNotFoundError}).
 */
export class AiGenerationNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message = "generation not found") {
    super(message);
    this.name = "AiGenerationNotFoundError";
  }
}

/**
 * Thrown by `POST /v1/ai/generations/:id/cancel` when the generation is already in a
 * TERMINAL state (`succeeded` / `failed` / `canceled`) — canceling completed work is a
 * client-state conflict. Maps to **409** (`generation_not_cancelable`), mirroring the
 * codebase's 409-for-state-conflict convention.
 */
export class GenerationNotCancelableError extends Error {
  readonly statusCode = 409;
  constructor(message = "generation is already terminal and cannot be canceled") {
    super(message);
    this.name = "GenerationNotCancelableError";
  }
}
