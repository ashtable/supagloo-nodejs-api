/**
 * Log redaction for the API process (plan row 43, design-delta §2.10).
 *
 * The API handles four classes of secret: the GitHub App private key and the installation
 * tokens minted from it, the AES `SECRETS_ENCRYPTION_KEY`, per-user provider credentials it
 * decrypts to verify a connection, and the Postgres/S3 credentials in its own connection
 * strings. Any of them can end up inside an `Error` — in a message, a stack frame, or a URL
 * — and Fastify's logger prints an error's `message` and `stack` verbatim. This process also
 * has something the worker does not: an HTTP request logger, which prints request headers,
 * i.e. the caller's `Authorization: Bearer <session token>` and `Cookie`.
 *
 * TWO LAYERS, because neither alone is enough:
 *
 *   1. **Shape matching** ({@link redactSecretsFromText}) catches values this process has
 *      never held: a `ghs_…` token in a fresh error from a library, a PEM block, a 64-hex
 *      key. It is the only layer that can work for a secret we cannot enumerate.
 *   2. **Exact-value matching** ({@link registerLogSecrets}) catches the ones with no
 *      recognisable shape at all — a Gloo client secret, `S3_SECRET_KEY` — by registering
 *      the CONFIGURED values once at boot from the validated env.
 *
 * …plus a third that is pino's rather than ours: {@link LOG_REDACT_PATHS} blanks known
 * header fields structurally, before any string ever reaches the two layers above.
 *
 * DELIBERATELY PARALLEL TO, NOT SHARED WITH, `supagloo-nodejs-dbos/src/logging/redact.ts`.
 * The two services are separate deployables with separate dependency graphs; the worker's
 * copy reuses its own `scaffold-project/git.ts` URL redactor, which this repo has no
 * counterpart of (the API never shells out to git). The shapes and the censor string are
 * kept identical so a secret leaking on one side would leak on the other — a divergence
 * here is a bug in one of them, not a feature.
 *
 * WHAT THIS DOES NOT FIX, and must not be read as fixing (design-delta §11.8:2469-2472):
 * on the worker side the installation token is still present in the git child's argv while
 * `git` runs, and in a clone's `.git/config`. Redacting what we LOG changes neither. That
 * residual is documented, accepted, and outside this row's scope.
 *
 * SCOPE NOTE: `registerLogSecrets` mutates module state exactly once, from `server.ts`,
 * before the app is built. Nothing in a request path writes it.
 */

/** Registered exact secret values. Module state, written once at boot from `server.ts`. */
const knownSecrets = new Set<string>();

/**
 * A value short enough that redacting it would corrupt unrelated log text. `"abc"` as a
 * secret would blank every occurrence of those three letters everywhere.
 */
const MIN_REGISTERABLE_SECRET_LENGTH = 8;

export const REDACTED = "***";

/**
 * Secret SHAPES, each with a reason to be here rather than a guess:
 *   - GitHub tokens: `ghs_` (installation), `ghp_`/`gho_`/`ghu_`/`ghr_` (user/PAT/refresh)
 *     and the fine-grained `github_pat_` form. The connection routes mint and hold one.
 *   - PEM private-key blocks: `GITHUB_APP_PRIVATE_KEY`, which arrives as env text and is
 *     echoed by some JWT libraries on a parse failure.
 *   - `sk-…`: the OpenRouter API-key shape, decrypted per user when verifying a connection.
 *   - Bearer / `token` authorization values: what a header dump looks like.
 *   - 64+ hex characters: the `SECRETS_ENCRYPTION_KEY` shape. Deliberately NOT 40 — a
 *     40-hex run is a git SHA, and git SHAs are among the most useful things in a
 *     git-ops-adjacent failure log. Starting at 64 keeps the redactor from being a
 *     debuggability regression.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[psour]_[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9\-_]{16,}/g,
  /\b(?:Bearer|bearer|token)\s+[A-Za-z0-9\-._~+/=]{16,}/g,
  /\b[0-9a-fA-F]{64,}\b/g,
];

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact the credential from any URL userinfo (`scheme://user:password@host`), applied to
 * EVERY occurrence and keyed to no particular value, so it also covers credentials this
 * code does not know about. The username is kept (`x-access-token:***@`) for debuggability;
 * a bare userinfo with no `user:pass` split is redacted whole (`***@`). Byte-for-byte the
 * behaviour of the worker's `redactUrlCredentials`.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(
    /(:\/\/)([^/@\s]*)@/g,
    (_full, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(":");
      const redacted =
        colon === -1 ? REDACTED : `${userinfo.slice(0, colon)}:${REDACTED}`;
      return `${scheme}${redacted}@`;
    },
  );
}

/**
 * Register secret VALUES (typically straight off the validated env) so they are redacted by
 * exact match wherever they appear. Empty, non-string and implausibly short values are
 * ignored — a three-character "secret" would redact half the log.
 */
export function registerLogSecrets(
  values: Array<string | undefined | null>,
): void {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.length < MIN_REGISTERABLE_SECRET_LENGTH) continue;
    knownSecrets.add(value);
  }
}

/** Test-only: drop every registered value. */
export function __resetLogSecrets(): void {
  knownSecrets.clear();
}

/** Scrub every known secret shape and every registered secret value out of `text`. */
export function redactSecretsFromText(text: string): string {
  let out = redactUrlCredentials(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  // Exact values LAST, so a registered value that also matched a shape is already gone and
  // this pass only has to catch the shapeless ones.
  for (const secret of knownSecrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return out;
}

/**
 * The redacted, JSON-serializable shape a log line carries instead of a raw error.
 *
 * `type` / `message` / `stack` are REQUIRED because that is the contract pino's `err`
 * serializer slot declares, and log consumers key on `type`. `stack` is `""` rather than
 * absent when an error carries none, so the field never changes shape between lines.
 */
export interface RedactedError {
  [key: string]: unknown;
  type: string;
  name: string;
  message: string;
  stack: string;
  code?: string | number;
  statusCode?: number;
  status?: number;
}

function scrub(value: unknown): string | undefined {
  return typeof value === "string" ? redactSecretsFromText(value) : undefined;
}

/**
 * The pino `err` serializer. Turns anything throwable into a PLAIN object with every string
 * scrubbed.
 *
 * Plain is load-bearing: an `Error` has no enumerable own properties, so pino's default
 * `err` serializer walks it specially and emits `message`, `stack`, `type` and every
 * attached field verbatim. Projecting onto a known set of keys is what makes "secrets are
 * never logged" checkable rather than aspirational — an unknown property carrying a token
 * is dropped rather than trusted.
 *
 * `statusCode` / `status` / `code` are kept because `error-handler.ts` classifies on
 * exactly those and an operator reading the log needs the same view it had.
 *
 * `cause` is DROPPED, not scrubbed — the same call the worker's serializer makes, for the
 * same reason: a nested unknown object of arbitrary depth is not something a serializer can
 * promise to have cleaned.
 */
export function redactForLog(err: unknown): RedactedError {
  if (err instanceof Error) {
    const extra = err as Error & {
      code?: unknown;
      statusCode?: unknown;
      status?: unknown;
    };
    const out: RedactedError = {
      type: err.constructor?.name ?? err.name,
      name: err.name,
      message: redactSecretsFromText(err.message),
      stack: scrub(err.stack) ?? "",
    };
    if (typeof extra.code === "number") out.code = extra.code;
    else if (typeof extra.code === "string")
      out.code = redactSecretsFromText(extra.code);
    if (typeof extra.statusCode === "number") out.statusCode = extra.statusCode;
    if (typeof extra.status === "number") out.status = extra.status;
    return out;
  }
  // A non-Error throwable (a string, a rejected plain object). Stringified first, then
  // scrubbed as text, so an unknown key holding a secret cannot escape by not being one of
  // the fields above.
  let asText: string;
  try {
    asText =
      typeof err === "string" ? err : (JSON.stringify(err) ?? String(err));
  } catch {
    asText = String(err);
  }
  return {
    type: "NonError",
    name: "NonError",
    message: redactSecretsFromText(asText),
    stack: "",
  };
}

/**
 * pino `redact` paths — structural blanking, applied before any serializer runs.
 *
 * These are the fields Fastify's own request/response serializers emit that carry caller
 * credentials. Shape matching cannot be relied on for them: a Supagloo session token is an
 * opaque random string with no prefix and no fixed length (`auth/tokens.ts`), so the only
 * thing that identifies it is WHERE it appears. That is exactly what a path list is for.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-yvp-app-key']",
  "request.headers.authorization",
  "request.headers.cookie",
  "res.headers['set-cookie']",
  "response.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
];

/** The pino options `buildApp` hands to Fastify: the path list plus the `err` serializer. */
export function buildLoggerOptions(): {
  redact: { paths: string[]; censor: string };
  serializers: { err: (err: unknown) => RedactedError };
} {
  return {
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
    serializers: { err: redactForLog },
  };
}
