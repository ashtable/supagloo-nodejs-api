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
 * …plus two more that are pino's rather than ours: {@link LOG_REDACT_PATHS} blanks known
 * header fields structurally, before any string ever reaches the two layers above, and
 * {@link buildLoggerOptions}'s `hooks.logMethod` scrubs `msg` — the ONE field neither a
 * serializer nor a path list can reach, because pino derives it from the log call's own
 * string argument (and, for a positional `Error`, from `err.message` AFTER serialization).
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

/**
 * The password inside a Postgres DSN, in BOTH serializations, or `[]` if there is none.
 *
 * WHY THIS EXISTS AT ALL. `redactUrlCredentials` is the only layer that knows what a URL
 * credential looks like, and its userinfo class stops at the FIRST `@` — measured:
 * `postgres://user:p@ssw0rdLong@db:5432/x` → `postgres://user:***@ssw0rdLong@db:5432/x`.
 * A password containing `@` is legal, common, and leaks its tail. The DSN is also the one
 * credential this process certainly holds and certainly logs on a connection failure
 * (`PrismaClientInitializationError` echoes the datasource URL), so it is registered by
 * EXACT VALUE at boot — layer 2 — rather than hoped to have a shape.
 *
 * WHY TWO STRINGS. `new URL(dsn).password` returns the PERCENT-ENCODED form regardless of
 * how the DSN was written, so `p@ssw0rdLong` comes back as `p%40ssw0rdLong`. Registering
 * only that would miss the raw text that actually appears in a Prisma error message, and
 * registering only the decoded form would miss an already-encoded DSN. Both, deduped.
 *
 * Never throws: this runs at boot, before anything is armed, and a malformed value must
 * become "no password to register" rather than the reason the process died.
 *
 * NOTE ON A DICTIONARY-WORD PASSWORD. The dev stack's DSN password is a short word that
 * also appears in this system's own vocabulary, so registering it blanks that word
 * everywhere in the dev log stream. That is the honest cost of layer 2 on a weak password —
 * `MIN_REGISTERABLE_SECRET_LENGTH` is the only floor, and a password IS a secret even when
 * it is a bad one. Do not add a "looks too ordinary to be a secret" exemption: it would
 * disable this fix in the one environment anyone actually runs.
 */
export function dsnPasswords(dsn: string | undefined | null): string[] {
  if (typeof dsn !== "string" || dsn.length === 0) return [];
  let encoded: string;
  try {
    encoded = new URL(dsn).password;
  } catch {
    return [];
  }
  if (encoded.length === 0) return [];
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // A lone `%` is not a valid escape; the raw form is still worth registering.
  }
  return decoded === encoded ? [encoded] : [encoded, decoded];
}

/** Scrub every known secret shape and every registered secret value out of `text`. */
export function redactSecretsFromText(text: string): string {
  // Exact values FIRST. This ordering is load-bearing, not cosmetic: `redactUrlCredentials`
  // rewrites `postgres://user:p@ssw0rd@host` into `postgres://user:***@ssw0rd@host`, which
  // DESTROYS the registered literal (`p@ssw0rd` no longer occurs) and leaves the tail in
  // place forever. Running the exact-value pass first turns the whole password into `***`
  // before any structural rewrite can split it — and keeps `redactUrlCredentials` itself
  // byte-identical to the worker's copy, which is the property this file's header promises.
  let out = text;
  for (const secret of knownSecrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  out = redactUrlCredentials(out);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
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
      // `String(...)`, not a bare read: `message` is declared `string` but is an ordinary
      // writable property, and a non-string one is reachable (a library attaching a
      // structured payload, a rejected object rewrapped by a helper). MEASURED: the bare
      // read threw `TypeError: text.replace is not a function`, and a throwing pino
      // serializer propagates out of `log.error` and writes ZERO lines — so the failure
      // mode was not a bad log line but the disappearance of the line. `stack`, `code` and
      // the rest were already guarded by `scrub`/`typeof`; this was the one that was not.
      message: redactSecretsFromText(String(err.message ?? "")),
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

/**
 * pino's `hooks.logMethod` — the ONLY seam that can reach `msg`.
 *
 * Neither `serializers.err` (which only ever sees the `err` KEY) nor `redact.paths` (a list
 * of object paths) touches `msg`, and `msg` is where a raw `error.message` lands on the
 * api's primary error path. MEASURED, in the shape Fastify itself uses:
 *
 * ```
 * log.error({ err }, err.message)   // fastify/lib/log-controller.js#defaultErrorLog
 *   → {"err":{"message":"upstream 502 token=***"},"msg":"upstream 502 token=<RAW>"}
 * ```
 *
 * That call is reached by DELEGATION, not by the generify branch: `error-handler.ts` does
 * `reply.send(err)` whenever `carriesIntentionalStatus(err)` — every declared status in
 * 400…599 except 500 — which hands off to Fastify's default handler, and for a 5xx that
 * handler logs `reply.log.error({ req, res, err }, error?.message)`. The generify branch's
 * message argument is a static literal and never carried the secret.
 *
 * Two normalizations, in order:
 *  1. a POSITIONAL `Error` with no message argument (`log.error(err)` — the listen catch's
 *     old shape, and Fastify's hook-failure shape) becomes `[{ err }, <redacted message>]`,
 *     because pino derives `msg` from `err.message` AFTER the serializer chain, where
 *     nothing of ours can intervene;
 *  2. every remaining string argument is scrubbed, which covers the `({ err }, err.message)`
 *     shape above and any hand-written message that interpolates a value.
 *
 * Fires for pino CHILD loggers too, which is what `req.log` / `reply.log` are — verified.
 */
function redactLogArguments(args: unknown[]): unknown[] {
  let normalized = args;
  const [first, second] = normalized;
  if (first instanceof Error && typeof second !== "string") {
    normalized = [
      { err: first },
      redactSecretsFromText(String(first.message ?? "")),
      ...normalized.slice(1),
    ];
  }
  return normalized.map((arg) =>
    typeof arg === "string" ? redactSecretsFromText(arg) : arg,
  );
}

/**
 * The pino options `buildApp` hands to Fastify: the path list, the `err` serializer and the
 * `msg` hook. All three keys are read by pino BY NAME — a typo is a silent no-op, which is
 * what `U-RED-9b` pins.
 */
export function buildLoggerOptions(): {
  redact: { paths: string[]; censor: string };
  serializers: { err: (err: unknown) => RedactedError };
  hooks: {
    logMethod: (
      this: unknown,
      args: unknown[],
      method: (...a: unknown[]) => void,
    ) => void;
  };
} {
  return {
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
    serializers: { err: redactForLog },
    hooks: {
      logMethod(this: unknown, args, method) {
        method.apply(this, redactLogArguments(args));
      },
    },
  };
}

/**
 * The label the api's boot failure carries, in argument 0 and unprefixed — the same
 * discipline `WORKER_FAILED_LOG` is held to on the worker side. Not grep-scraped by another
 * repo today (only the worker's two constants are, see the root brief §0.7), but pinned as
 * a constant so it cannot drift silently if that ever changes.
 */
export const API_BOOT_FAILED_LOG = "[supagloo-api] failed to start:";

/** Injectable stderr + exit, so the boot handler is testable without ending the test run. */
export interface BootFailureIo {
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
}

/**
 * Report a fatal boot failure, REDACTED, and exit non-zero.
 *
 * WHY THE ENTRY POINT NEEDS THIS. `server.ts`'s `main()` runs `loadEnv()`,
 * `registerLogSecrets(...)` and `createPrismaClient({ connectionString: env.DATABASE_URL })`
 * before it ever reaches the listen try/catch. A bare `void main()` hands any rejection
 * there to Node's DEFAULT unhandled-rejection handler, which prints the raw `Error`, its
 * whole `cause` chain and every attached property into the shared Compose log stream —
 * often before `registerLogSecrets` has even run. The exit code is 1 either way, which is
 * precisely why row 43's own boot e2e (E-BH1/E-BH2, which read stderr and assert a non-zero
 * exit) stayed green over it. Mirrors `supagloo-nodejs-dbos/src/main.ts:56-64`.
 *
 * The payload build is itself wrapped: a serializer that throws while reporting a fatal
 * error would suppress the only line that explains the crash. The fallback is scrubbed
 * text, never the raw error.
 */
export function reportBootFailure(
  err: unknown,
  io: BootFailureIo = {
    // `console.error`, not `app.log.error`: this fires for failures that happen BEFORE
    // `buildApp`, so there is no Fastify logger to reach — and the redaction is applied to
    // the payload here rather than relying on the logger's options.
    error: (...args: unknown[]) => console.error(...args),
    exit: (code: number) => process.exit(code),
  },
): void {
  let payload: unknown;
  try {
    payload = redactForLog(err);
  } catch {
    payload = redactSecretsFromText(String(err));
  }
  io.error(API_BOOT_FAILED_LOG, payload);
  io.exit(1);
}
