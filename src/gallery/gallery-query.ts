import {
  GallerySortSchema,
  Prisma,
  type GallerySort,
} from "@supagloo/database-lib";
import { findPostgresTextViolation } from "../postgres-text";
import { TRENDING } from "./trending";

/**
 * The gallery listing's raw-SQL builder and its opaque cursor codec (Task #39, plan
 * D4/D5/D9). This is the FIRST `$queryRaw` in the api, so the safety rules are spelled
 * out rather than assumed.
 *
 * WHY RAW SQL AT ALL (plan D4). The cursor is a KEYSET predicate — `(sortKey, id) < ($k,
 * $i)` — which Prisma's `orderBy` + `cursor` cannot express over a computed expression
 * (`trending` has no column). Splitting into "Prisma for the two column sorts, raw for
 * trending" would mean TWO cursor implementations, and keyset pagination is exactly where
 * skip/duplicate bugs live. One builder, one predicate shape, one set of tests.
 *
 * WHY IT IS SAFE, and these three rules are non-negotiable — each names the test that HOLDS
 * it, because until 2026-07-26 rule 1 had nothing holding it at all (an audit's mutation
 * interpolated the request's `sort` straight into the ORDER BY clause and the whole suite,
 * 79 unit and 25 e2e, stayed green):
 *   1. `sort` is a CLOSED enum at the Zod boundary, and the ORDER BY key expression is
 *      selected from the fixed {@link GALLERY_SORT_KEY_SQL} map — never built from the
 *      request string. Held by **U-GQ4c**: the ORDER BY key is the fixed output alias and no
 *      sort NAME may appear anywhere in the static SQL;
 *   2. every value (`$now`/`$t`, `$q`, the cursor's `$k`/`$i`, `$limit`) is a BOUND
 *      parameter via the tagged template. Held by **U-GQ5**, which drives a hostile `q` and a
 *      hostile cursor `i` through and asserts they appear only in `values`;
 *   3. `Prisma.raw` is used ONLY on the three numeric constants in {@link TRENDING}.
 *      Held by U-GQ4 + U-GQ5 together.
 *
 * A FOURTH rule, learned the hard way TWICE: being parameterised is not the same as being
 * SAFE. A bound parameter still has to be a value the column's type accepts, or Postgres
 * raises and the reply is a 500 carrying the SQLSTATE and the literal to an anonymous caller.
 * Two kinds of gate enforce it, and the split matters:
 *   - a VALUE GRAMMAR, where the parameter's type has one: {@link isStrictIsoInstant} for the
 *     `newest` key and the trending epoch, `Number.isInteger` + int4 bounds for the `popular`
 *     key, `Number.isSafeInteger` + {@link GALLERY_MAX_ORDINAL} for the ordinal;
 *   - the SHARED TEXT RULE (`../postgres-text`) for every free string — the cursor's `i`, `q`,
 *     the `:id` params and the publish body. It lives in one module, applied at each value's
 *     own boundary, because the first attempt at this wrote a separate check per field and
 *     LEFT ONE OUT: `i` stayed an unauthenticated 500 on all three sorts while a test claimed
 *     the class was closed. One rule, many boundaries, no per-field re-derivation.
 *
 * Deliberately NOT here: any `book` predicate. The `book=` query parameter was cut on
 * 2026-07-26 — which books exist is a property of the TRANSLATION, with the YouVersion API
 * as the authority on it, so a facet enumerated from a canon hardcoded in this repo was the
 * wrong design. `scriptureBook` is still persisted; nothing queries it.
 *
 * The query returns ids + sort keys ONLY. Row → DTO mapping stays on the typed Prisma
 * model (raw rows come back untyped and would need hand-written casts for sixteen
 * columns), so raw SQL owns exactly ordering and pagination.
 */

/**
 * Rows per page. A whole number of rows in the wireframe's `repeat(4, 1fr)` grid.
 *
 * `limit` is deliberately NOT a client parameter: the design names none, and an unbounded
 * client limit on a public, unauthenticated endpoint is a trivial DoS. It is a
 * `GalleryService` constructor option purely so tests can use 2.
 */
export const GALLERY_PAGE_SIZE = 24;

/** Postgres seconds-per-hour divisor, as a SQL literal (never user input). */
const SECONDS_PER_HOUR = "3600.0";

/**
 * The ORDER BY key expression per sort — a FIXED map keyed by the closed `GallerySort`
 * enum. The request string selects a KEY OF THIS OBJECT and nothing else.
 *
 * Each entry is a function of the pagination epoch rather than a bare `Prisma.Sql`
 * (a deliberate deviation from the plan's `Record<GallerySort, Prisma.Sql>` sketch):
 * trending's expression must BIND an instant, and a pre-built fragment cannot carry a
 * per-request one. It is still a fixed, closed map — the map itself is what is indexed by
 * the request value.
 *
 * The two column sorts ignore their argument, which is why `now` never leaks into their
 * bound values.
 */
export const GALLERY_SORT_KEY_SQL: Record<
  GallerySort,
  (epoch: Date) => Prisma.Sql
> = {
  popular: () => Prisma.sql`"upvoteCount"`,
  newest: () => Prisma.sql`"publishedAt"`,
  // The plan D3 expression. Its three constants come from TRENDING via `Prisma.raw` on
  // NUMBERS only; its instant is a BOUND parameter, never `now()` — a `now()` here would
  // re-score every page of one "Load more" run against a different instant, which is
  // precisely what the cursor epoch exists to prevent. `GREATEST(…, 0)` clamps clock skew
  // (a negative base to a fractional power is an ERROR in Postgres, not a NaN). The
  // explicit `::double precision` on the age keeps the arithmetic in float, so this agrees
  // with the `trendingScore` twin instead of drifting into `numeric` semantics.
  trending: (epoch: Date) =>
    Prisma.sql`(("upvoteCount")::double precision + ${Prisma.raw(String(TRENDING.voteOffset))}) / power(GREATEST(EXTRACT(EPOCH FROM (${epoch}::timestamptz - "publishedAt"))::double precision / ${Prisma.raw(SECONDS_PER_HOUR)}, 0) + ${Prisma.raw(String(TRENDING.ageOffsetHours))}, ${Prisma.raw(String(TRENDING.gravity))})`,
};

/**
 * The cursor key, BOUND with the cast that matches its sort's key expression — `k` travels
 * through JSON, so a `newest` key arrives as an ISO-8601 STRING and a `trending` key as a
 * double.
 *
 * MEASURED, not assumed: removing the `::timestamptz` and re-running the real-Postgres
 * `newest` pagination walk (E-G8b) still passes, because Prisma leaves these parameters'
 * types unspecified and Postgres infers each one from the column it is compared against — so
 * the casts are NOT load-bearing today. They stay because they make the intended type
 * explicit at the one boundary whose behaviour belongs to the driver rather than to us: if
 * the client ever began declaring parameter types, `timestamptz < text` has no operator and
 * every page after the first would 500. Casting the PARAMETER rather than the column also
 * leaves the D1 composite indexes usable.
 *
 * The cast is also what makes the codec's per-sort key validation load-bearing: it is why a
 * forged `newest` cursor carrying `42` must be rejected up front. `'42'::timestamptz` is a
 * Postgres error (verified 2026-07-26: `date/time field value out of range`), so accepting
 * such a cursor would turn a forged query parameter into a 500 instead of a 400.
 *
 * CORRECTED 2026-07-26: an earlier version of this comment implied the per-sort TYPE check
 * was sufficient, and it was not. Rejecting a number under `newest` closes nothing about
 * which STRINGS Postgres will take, and the old `!Number.isNaN(Date.parse(k))` guard was a
 * proxy for that, not a test of it — `"2026"`, `"Jan 2000"` and `"2020-02-30T00:00:00Z"` all
 * passed it and 500ed here (22007 / 22007 / 22008). What closes it is the VALUE grammar,
 * {@link isStrictIsoInstant}, not the type check and not `Date.parse`.
 */
const SORT_KEY_PARAM: Record<
  GallerySort,
  (k: number | string) => Prisma.Sql
> = {
  popular: (k) => Prisma.sql`${k}::integer`,
  newest: (k) => Prisma.sql`${k}::timestamptz`,
  trending: (k) => Prisma.sql`${k}::double precision`,
};

/** `upvoteCount` is an `Int` column, so a `popular` key outside int4 must be rejected at
 *  the codec rather than blowing up as a 500 inside Postgres's cast. */
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

/**
 * The deepest page position a cursor may claim.
 *
 * `n` is the last row's 1-based ordinal and it feeds `rank`, which the wire DTO types
 * `z.number().int()`. A forged `n` of `Number.MAX_SAFE_INTEGER` therefore produced a
 * `500 FST_ERR_RESPONSE_SERIALIZATION` under `sort=popular` — the reply could not be
 * serialized against its own schema. `Number.isSafeInteger` (which the sibling popular-key
 * check six lines below already used, while the `n` check did not) closes the float cases;
 * this ceiling closes the rest, because an ordinal is a POSITION in a listing and 41 666
 * pages of 24 is already far past anything a client walks. It also keeps every derived
 * `rank` inside int4.
 */
export const GALLERY_MAX_ORDINAL = 1_000_000;

/**
 * Longest accepted `q`.
 *
 * `q` had NO bound at all. It was limited only ACCIDENTALLY, by Node's 16 KB request-line
 * limit (12 000 chars answered 200; 20 000 answered 431) — so a 12 KB search term became
 * three `ILIKE '%…%'` comparisons per row on a public, unauthenticated, unindexed,
 * unrate-limited endpoint. The plan reasoned explicitly about DoS for `limit`
 * ({@link GALLERY_PAGE_SIZE}) and not at all for this.
 *
 * 200 is comfortably longer than the longest title the publish schema accepts (120) and
 * than any phrase a person types into a search box, so the bound is invisible in real use.
 */
export const GALLERY_MAX_Q_LENGTH = 200;

/**
 * A strict ISO-8601 INSTANT: `YYYY-MM-DDTHH:MM:SS[.f{1,6}]` plus `Z` or `±HH:MM`.
 *
 * Deliberately a grammar and not a call to `Date.parse`. V8's parser is FAR more permissive
 * than Postgres's `timestamptz` parser, and the gap was reachable: `"2026"`, `"Jan 2000"`,
 * `"2020-02-30T00:00:00Z"`, `"Thu Jan 01 1970 00:00:00 GMT+0000 (…)"` and
 * `"-271821-04-20T00:00:00.000Z"` all satisfied `!Number.isNaN(Date.parse(k))` and then
 * failed INSIDE Postgres (SQLSTATE 22007 / 22008 / 22009) as an UNAUTHENTICATED 500 whose
 * body carried the SQLSTATE and the offending literal.
 *
 * The four-digit year is load-bearing twice over: it rejects V8's ±six-digit expanded years
 * (`-271821-…`, `+275760-…`), which are legal JS instants and outside `timestamptz`'s range,
 * and it keeps every accepted value inside a range Postgres parses without complaint.
 *
 * MEASURED against the real Compose Postgres over the whole grammar's extremes
 * (`scratch/probe-grammar.ts`, 2026-07-26), which is how the two residual holes below were
 * found — neither was in the audit, and both would still have been unauthenticated 500s:
 *   - `0000-01-01T00:00:00Z` → **22008**. Postgres's proleptic calendar has NO year zero (it
 *     numbers 1 BC, not 0), so the year floor is 1, not 0000.
 *   - `2026-07-26T12:00:00+16:00` → **22009** `time zone displacement out of range`. Postgres
 *     tolerates up to ±15:59; the bound here is the tighter ±14:00, which is ISO-8601's own
 *     limit and larger than every real-world zone (Line Islands is exactly +14:00).
 * Everything the grammar accepts now round-trips through BOTH cursor paths: bound as text and
 * cast (`k`) and bound as a JS `Date` (`t`).
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Is `value` a timestamp this codec will hand to Postgres?
 *
 * The calendar fields are checked ARITHMETICALLY rather than by round-tripping through
 * `Date`: `Date.UTC(2020, 1, 30)` silently rolls over to March 1st, so a round-trip
 * comparison would accept February 30th — the exact input whose 22008 the old JSDoc claimed
 * to have fixed.
 */
export function isStrictIsoInstant(value: string): boolean {
  const m = ISO_INSTANT.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(
    Number,
  );
  // No year zero in Postgres's calendar.
  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) return false;
  // No leap-second carve-out: Postgres accepts `:60` by rolling it over, but nothing in
  // this system ever mints one, and rolling a forged value is not a behaviour worth having.
  if (hour > 23 || minute > 59 || second > 59) return false;

  // `Z` (no offset group captured) is always fine; an explicit offset must be a real one.
  if (m[7] === undefined) return true;
  const offsetHours = Number(m[8]);
  const offsetMinutes = Number(m[9]);
  if (offsetMinutes > 59) return false;
  return offsetHours < 14 || (offsetHours === 14 && offsetMinutes === 0);
}

/**
 * The opaque pagination cursor. Base64url of this compact JSON object.
 *
 * Opaque so the shape can change without a wire break; deliberately NOT signed or
 * encrypted — it carries no secret and no authorization, only ordering coordinates, and a
 * forged cursor can at worst page a public listing oddly.
 */
export interface GalleryCursor {
  /** The sort it was minted under. Replaying it under another sort is an ERROR (D5). */
  s: GallerySort;
  /** The last row's sort key: a number, or an ISO-8601 string under `newest`. */
  k: number | string;
  /** The last row's id — the tiebreak that makes the keyset a TOTAL order. */
  i: string;
  /** The last row's 1-based ordinal, which feeds `rank` continuity across pages (D11). */
  n: number;
  /** `trending` ONLY: the frozen pagination epoch. Its absence there is an error. */
  t?: string;
}

export type DecodedCursor =
  | { ok: true; cursor: GalleryCursor }
  | { ok: false; reason: string };

export type ParsedCursor =
  | { ok: true; cursor: GalleryCursor | null }
  | { ok: false; reason: string };

const reject = (reason: string): { ok: false; reason: string } => ({
  ok: false,
  reason,
});

/** Base64url alphabet, checked BEFORE decoding: `Buffer.from(…, "base64url")` silently
 *  ignores characters outside it, so "is this even base64url?" has to be asked first. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Encode a cursor. `t` is omitted entirely unless it is set, so a `popular` cursor is
 *  exactly four fields. */
export function encodeCursor(cursor: GalleryCursor): string {
  const payload: GalleryCursor = {
    s: cursor.s,
    k: cursor.k,
    i: cursor.i,
    n: cursor.n,
    ...(cursor.t === undefined ? {} : { t: cursor.t }),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode and FULLY validate a cursor. Total and pure: every malformed input returns a
 * tagged rejection, nothing throws, and nothing is partially accepted.
 *
 * The per-sort key check is what keeps a forged cursor a 400 instead of a 500: a `newest`
 * cursor carrying a number, or a `popular` cursor carrying a value outside int4, would
 * otherwise fail inside Postgres's cast.
 */
export function decodeCursor(raw: string): DecodedCursor {
  if (!BASE64URL.test(raw)) return reject("cursor is not base64url");

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return reject("cursor is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject("cursor is not a JSON object");
  }
  const c = parsed as Record<string, unknown>;

  const sortResult = GallerySortSchema.safeParse(c.s);
  if (!sortResult.success) return reject("cursor sort is not a known sort");
  const s = sortResult.data;

  if (typeof c.i !== "string" || c.i.length === 0) {
    return reject("cursor id is missing or empty");
  }
  // `i` IS A BOUND PARAMETER IN THE SAME KEYSET PREDICATE rule 2 above names, and until
  // 2026-07-26 it was the only one of the cursor's four values with no VALUE gate — only a
  // typeof/emptiness check. `{"s":"newest","k":"…","i":"\\u0000","n":1}` therefore reached
  // `$queryRaw` and answered `500` (P2010 → SQLSTATE 22021) to an anonymous caller, on ALL
  // THREE sorts. The gate is the shared rule, not a local check, because a local check here
  // is what produced the gap: `k`, `t` and `n` each got one and `i` was overlooked.
  const idViolation = findPostgresTextViolation(c.i);
  if (idViolation !== null) return reject(`cursor id ${idViolation}`);
  if (
    typeof c.n !== "number" ||
    !Number.isSafeInteger(c.n) ||
    c.n < 0 ||
    c.n > GALLERY_MAX_ORDINAL
  ) {
    return reject("cursor ordinal is not a safe integer within the page-position bound");
  }

  const k = c.k;
  if (s === "newest") {
    if (typeof k !== "string" || !isStrictIsoInstant(k)) {
      return reject("newest cursor key is not a strict ISO-8601 instant");
    }
  } else if (typeof k !== "number" || !Number.isFinite(k)) {
    return reject(`${s} cursor key is not a finite number`);
  } else if (s === "popular") {
    // TWO rejections, not one, because they are two different faults and the client fixes
    // them differently. Until 2026-07-26 both said "out of range for upvoteCount", so a
    // `k` of `1.5` — rejected because `upvoteCount` is an INTEGER column, and comfortably
    // inside int4 — sent the reader hunting for a bound that was never the problem.
    if (!Number.isInteger(k)) {
      return reject(
        "popular cursor key is not an integer (upvoteCount is an integer column)",
      );
    }
    if (k < INT4_MIN || k > INT4_MAX) {
      return reject(
        "popular cursor key is out of range for upvoteCount (int4: -2147483648…2147483647)",
      );
    }
  }

  // A trending cursor without an epoch is MEANINGLESS: every row's key would drift every
  // second and the drift would be unbounded (plan D5).
  let t: string | undefined;
  if (s === "trending") {
    // Validated by the SAME grammar as `k`: the epoch is bound as a Date rather than cast in
    // SQL, so only a JS-valid-but-Postgres-out-of-range instant broke it — and
    // `-271821-04-20T00:00:00.000Z` is exactly that (SQLSTATE 22009).
    if (typeof c.t !== "string" || !isStrictIsoInstant(c.t)) {
      return reject(
        "trending cursor is missing its pagination epoch, or the epoch is not a strict ISO-8601 instant",
      );
    }
    t = c.t;
  }

  return {
    ok: true,
    cursor: { s, k: k as number | string, i: c.i, n: c.n, ...(t === undefined ? {} : { t }) },
  };
}

/**
 * Resolve the request's `cursor` parameter against the request's `sort`.
 *
 * An absent or blank cursor means PAGE ONE — a UI that always appends the parameter must
 * not get a 400. Anything else that will not decode is an error, and so is a cursor minted
 * under a DIFFERENT sort: honouring that would page a different ordering and silently skip
 * or duplicate large ranges, so changing the sort must restart pagination.
 */
export function parseCursor(
  raw: string | undefined,
  sort: GallerySort,
): ParsedCursor {
  if (raw === undefined || raw.trim().length === 0) {
    return { ok: true, cursor: null };
  }
  const decoded = decodeCursor(raw);
  if (!decoded.ok) return decoded;
  if (decoded.cursor.s !== sort) {
    return reject(
      `cursor was minted for sort=${decoded.cursor.s}, not sort=${sort}`,
    );
  }
  return { ok: true, cursor: decoded.cursor };
}

/**
 * Escape the three `LIKE` metacharacters so a user's `q` matches LITERALLY.
 *
 * This is the point of the whole function: without it a `q` of `%` matches everything and
 * a `q` of `_` matches any single character — a real, easily-missed bug on a public search
 * box. Quotes and semicolons are NOT escaped here; those are the BINDING's job, not
 * `LIKE`'s.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type ParsedSearchTerm =
  | { ok: true; q: string | undefined }
  | { ok: false; reason: string };

/**
 * Validate the request's `q` BEFORE it can reach an `ILIKE` parameter.
 *
 * The `GalleryListQuerySchema` wire shape is `q: z.string().optional()` and lives in db-lib,
 * so this is where the api bounds it. Symmetric with {@link parseCursor}: pure, total, a
 * tagged union, and called by the service before any SQL is built.
 *
 * REJECT rather than repair, for both rules. Stripping the control characters would make
 * `q=%00` behave exactly like a BLANK `q` — i.e. answer a hostile input with a
 * match-everything listing — and truncating an over-long `q` would return hits for a prefix
 * of what the caller sent, so the response would be a lie about what was searched. A 400
 * names the problem instead.
 *
 * Blank or whitespace-only is ABSENT, not an error: a UI that always appends `q=` must not
 * 400, and an absent `q` emits no predicate at all (never `'%%'`).
 */
export function parseSearchTerm(raw: string | undefined): ParsedSearchTerm {
  if (raw === undefined) return { ok: true, q: undefined };

  // ORDER IS LOAD-BEARING: the text rule is tested on the RAW string, BEFORE any trimming.
  // `String.prototype.trim()` treats five C0 characters as whitespace — tab, LF, **VT
  // (U+000B)**, **FF (U+000C)** and CR — while only three are exempt, so trimming first
  // DELETED THE EVIDENCE for the other two: `?q=%0B` and `?q=%0C` became a blank `q` and
  // were answered with a 200 MATCH-EVERYTHING LISTING, which is exactly the "answer a
  // hostile input with everything" outcome the reject-don't-repair rule below exists to
  // prevent. (`?q=a%0Bb` was already rejected, because trim cannot reach the middle of a
  // string — which is why the test that existed passed while the bug lived.)
  const violation = findPostgresTextViolation(raw);
  if (violation !== null) return reject(`q ${violation}`);

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, q: undefined };
  if (trimmed.length > GALLERY_MAX_Q_LENGTH) {
    return reject(`q is longer than ${GALLERY_MAX_Q_LENGTH} characters`);
  }
  // The ORIGINAL string, not the trimmed one: the builder trims again and the two must not
  // disagree about what was searched. Trimming here is only how "blank means absent" and the
  // length bound are measured.
  return { ok: true, q: raw };
}

export interface BuildGalleryListQueryInput {
  sort: GallerySort;
  /** The DECODED cursor (`parseCursor`'s output), or null for page one. */
  cursor: GalleryCursor | null;
  /** The request instant. Page one's trending epoch; ignored by the column sorts. */
  now: Date;
  pageSize: number;
  /** Raw client `q`. Blank/whitespace is treated as ABSENT, never as `%%`. */
  q?: string;
}

export interface BuiltGalleryListQuery {
  sql: Prisma.Sql;
  /**
   * The instant the trending keys were scored against — `cursor.t` when paginating, `now`
   * on page one. The service puts this in the cursor it mints, which is what keeps the age
   * term constant for a whole "Load more" run.
   */
  epoch: Date;
}

/**
 * Build the listing query: ids + sort keys, `visibility='public'` only, optional ILIKE
 * search, optional keyset predicate, `ORDER BY <key> DESC, "id" DESC`, `LIMIT pageSize+1`.
 *
 * The `+1` is the EXHAUSTION PROBE: the service returns `pageSize` rows and mints a
 * `nextCursor` only if the extra row existed, so `nextCursor === null` means genuinely
 * exhausted rather than "this page was short".
 */
export function buildGalleryListQuery(
  input: BuildGalleryListQueryInput,
): BuiltGalleryListQuery {
  const { sort, cursor, now, pageSize } = input;
  const epoch = cursor?.t ? new Date(cursor.t) : now;
  const keyOf = GALLERY_SORT_KEY_SQL[sort];

  const trimmed = (input.q ?? "").trim();
  // A blank `q` emits NO predicate. `'%' + '' + '%'` would be a match-everything scan.
  const search =
    trimmed.length === 0
      ? Prisma.empty
      : (() => {
          const pattern = `%${escapeLike(trimmed)}%`;
          return Prisma.sql` AND ("title" ILIKE ${pattern} ESCAPE '\\' OR "description" ILIKE ${pattern} ESCAPE '\\' OR "scriptureReference" ILIKE ${pattern} ESCAPE '\\')`;
        })();

  // Postgres row-comparison IS the composite keyset predicate, and it is exactly what the
  // D1 `(visibility, <key>, id)` composite indexes serve.
  const keyset =
    cursor === null
      ? Prisma.empty
      : Prisma.sql` AND (${keyOf(epoch)}, "id") < (${SORT_KEY_PARAM[sort](cursor.k)}, ${cursor.i})`;

  // ORDER BY reuses the SELECT's output alias so the trending expression is written once
  // per clause it is actually needed in (the WHERE predicate cannot use an alias).
  const sql = Prisma.sql`SELECT "id", ${keyOf(epoch)} AS "sortKey" FROM "GalleryItem" WHERE "visibility" = 'public'${search}${keyset} ORDER BY "sortKey" DESC, "id" DESC LIMIT ${pageSize + 1}`;

  return { sql, epoch };
}
