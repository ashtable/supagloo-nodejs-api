import { z } from "zod";

/**
 * THE ONE RULE for "a string this api is willing to bind as a Postgres `text` parameter",
 * and the ONE place it is decided.
 *
 * WHY THIS MODULE EXISTS — and it is a process lesson, not just a technical one. On
 * 2026-07-26 an audit found ten unauthenticated 500s behind bound parameters on the gallery
 * surface. The fix gated three fields of the pagination cursor (`k`, `t`, `n`) and shipped a
 * test whose title claimed the whole class was closed. A FOURTH field of the SAME cursor —
 * `i`, the id half of the keyset predicate — was still an unauthenticated 500 on all three
 * sorts, and so were the `:id` path parameter of both anonymous item routes and three of the
 * publish body's four strings. Per-field patches move the gap; they do not close it.
 *
 * So the rule lives HERE, once, and every request-derived string on the surface passes
 * through it at its own boundary:
 *
 * | value                          | boundary                                     |
 * |--------------------------------|----------------------------------------------|
 * | cursor `i`                     | `decodeCursor` (400 `invalid_cursor`)        |
 * | `q`                            | `parseSearchTerm` (400 `invalid_query`)      |
 * | `:id` on every gallery route   | the route's params schema (400, Zod)         |
 * | the publish body's strings     | the route's body schema (400, Zod)           |
 *
 * The Zod boundaries use {@link withPostgresSafeStrings}, which WALKS the parsed value
 * rather than naming fields — so a schema that grows a new string is gated with no change
 * here and no change at the call site. That walk is the actual anti-regression measure.
 *
 * WHAT IS AND IS NOT MEASURED. Every claim below was driven against the Compose
 * Postgres 17 through the real Prisma 7.8 client, both as `$queryRaw` with a bound parameter
 * (`SELECT $1::text`, the listing's path) and as a typed `findFirst({ where: { id } })` (the
 * `:id` path):
 *
 * | input                              | `$queryRaw`            | typed client            |
 * |------------------------------------|------------------------|-------------------------|
 * | `U+0000`                           | **P2010 / 22021**      | **DriverAdapterError**  |
 * | other C0, DEL, C1                  | round-trips IDENTICAL  | fine                    |
 * | unpaired surrogate                 | **MUTATED to U+FFFD**  | fine (mutated)          |
 * | valid surrogate pair, noncharacters| round-trips IDENTICAL  | fine                    |
 * | 1 MB of text                       | round-trips IDENTICAL  | fine                    |
 *
 * So the three clauses of the rule have THREE DIFFERENT justifications, and conflating them
 * would be dishonest:
 *
 *  1. **`U+0000` is a hard error.** This is the only value Postgres refuses, and it is the
 *     one that produced every 500. Non-negotiable.
 *  2. **The rest of C0 + DEL is POLICY.** Postgres carries them fine. They are refused
 *     because none of them carries search or display meaning, and one checkable predicate is
 *     a better rule than a single-character carve-out that the next control character walks
 *     around. Tab / newline / carriage return are exempt (see below).
 *  3. **An unpaired surrogate is refused for HONESTY, not safety.** It never reaches
 *     Postgres as sent — the driver transcodes it to `U+FFFD` — so the api would have
 *     validated a string the database never stored: a `q` would search for something else
 *     and a `title` would be silently rewritten. That is the same "reject, do not repair"
 *     rule that governs `q`. It is NOT a 500 today, and this module must not be read as
 *     claiming it was.
 *
 * NOT this module's business, deliberately: `LIKE` metacharacters (`escapeLike`'s job),
 * quotes and semicolons (the BINDING's job — see `gallery-query.ts` rule 2), length bounds
 * (per-field, e.g. `GALLERY_MAX_Q_LENGTH`), and value GRAMMARS such as a timestamp
 * (`isStrictIsoInstant`). A rule that grows into a general-purpose "suspicious string"
 * filter starts rejecting real titles and real searches for no safety gain.
 */

/**
 * The C0 controls this rule EXEMPTS, by code point: tab, line feed, carriage return.
 * Exactly three, pinned here and asserted member-by-member by U-PT2.
 *
 * THE N3 TRAP, and the reason this is a `readonly number[]` rather than a comment:
 * `String.prototype.trim()` treats FIVE C0 characters as whitespace — tab, LF, **vertical
 * tab (U+000B)**, **form feed (U+000C)** and CR. So a caller that trims BEFORE testing this
 * class deletes the evidence for two of them: `?q=%0B` and `?q=%0C` collapsed to a blank `q`
 * and were answered with a 200 MATCH-EVERYTHING LISTING — precisely the outcome
 * "reject, do not repair" exists to prevent. VT and FF are NOT exempt, and every caller must
 * test the RAW string before any trimming.
 */
export const POSTGRES_TEXT_EXEMPT_CONTROL_CODES: readonly number[] = [
  0x09, // TAB
  0x0a, // LF
  0x0d, // CR
];

/**
 * C0 (U+0000–U+001F) + DEL (U+007F), less the exempt code points — DERIVED from
 * {@link POSTGRES_TEXT_EXEMPT_CONTROL_CODES} rather than written out a second time.
 *
 * That is deliberate. Two hand-maintained representations of one set is exactly how the
 * previous version's JSDoc came to name `\t \n \r` while the code's effective behaviour
 * exempted five characters. There is now ONE list, and the character class cannot disagree
 * with it. (U-PT2 still checks the resulting BEHAVIOUR across all 33 code points, so the
 * derivation itself is held by a test rather than trusted.)
 */
const FORBIDDEN_CONTROL_CHARS = new RegExp(
  `[${[...Array.from({ length: 32 }, (_, i) => i), 0x7f]
    .filter((code) => !POSTGRES_TEXT_EXEMPT_CONTROL_CODES.includes(code))
    .map((code) => `\\u${code.toString(16).padStart(4, "0")}`)
    .join("")}]`,
);

/**
 * A UTF-16 code unit in the surrogate range that is not part of a well-formed pair: a high
 * surrogate not followed by a low one, or a low surrogate not preceded by a high one.
 * `JSON.parse` produces these happily from `"\ud800"`, which is how one reaches a cursor's
 * `i` or a publish body's `title`.
 */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why `value` may not be bound as Postgres `text`, or `null` if it may.
 *
 * Returns a REASON rather than a boolean because every caller puts it in a 400 body, and
 * "contains a control character" is actionable where "invalid" is not. The reason is safe to
 * echo: it names the CLASS, never the offending bytes, so nothing hostile is reflected back.
 */
export function findPostgresTextViolation(value: string): string | null {
  if (FORBIDDEN_CONTROL_CHARS.test(value)) {
    return "contains a control character (only tab, newline and carriage return are allowed)";
  }
  if (UNPAIRED_SURROGATE.test(value)) {
    return "contains an unpaired UTF-16 surrogate";
  }
  return null;
}

/** {@link findPostgresTextViolation} as a predicate, for callers that only branch. */
export function isPostgresSafeText(value: string): boolean {
  return findPostgresTextViolation(value) === null;
}

/**
 * Walk `value` and report every string that violates the rule, at its own path.
 *
 * The walk covers objects, arrays and nested combinations of them, so the gate applies to
 * the WHOLE parsed value rather than to a hand-maintained list of field names. It runs on
 * the PARSED output, which is what actually reaches Prisma — so a `z.string().trim()` field
 * is checked at the value that will be inserted, not at the raw one.
 */
function walkStrings(
  value: unknown,
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): void {
  if (typeof value === "string") {
    const violation = findPostgresTextViolation(value);
    if (violation !== null) {
      ctx.addIssue({ code: "custom", message: violation, path: [...path] });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkStrings(entry, [...path, index], ctx));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      walkStrings(entry, [...path, key], ctx);
    }
  }
}

/**
 * Wrap a request schema so EVERY string it parses must satisfy the rule.
 *
 * Used at the two Fastify schema boundaries (`params`, `body`) that the gallery routes own.
 * It refines the SHARED db-lib schema rather than re-declaring it, which matters for two
 * reasons: db-lib is not editable from this repo (its `GalleryIdParamSchema` is
 * `z.string().min(1)`), and re-declaring a contract in the consumer is how two contracts
 * start to disagree.
 *
 * Zod 4's `.superRefine()` attaches the check to the schema and returns the SAME schema
 * type, so a wrapped `ZodObject` is still a `ZodObject` — `.extend()` still works and the
 * Fastify type provider's `req.params` / `req.body` inference is unchanged. U-PT5 pins that.
 */
export function withPostgresSafeStrings<S extends z.ZodType>(schema: S): S {
  return schema.superRefine((value, ctx) => {
    walkStrings(value, [], ctx);
  }) as unknown as S;
}
