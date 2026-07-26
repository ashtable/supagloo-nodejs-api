import {
  GallerySortSchema,
  Prisma,
  type GallerySort,
} from "@supagloo/database-lib";
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
 * WHY IT IS SAFE, and these three rules are non-negotiable:
 *   1. `sort` is a CLOSED enum at the Zod boundary, and the ORDER BY key expression is
 *      selected from the fixed {@link GALLERY_SORT_KEY_SQL} map — never built from the
 *      request string;
 *   2. every value (`$now`/`$t`, `$q`, the cursor's `$k`/`$i`, `$limit`) is a BOUND
 *      parameter via the tagged template;
 *   3. `Prisma.raw` is used ONLY on the three numeric constants in {@link TRENDING}.
 *      A unit test asserts no request value ever appears in the emitted SQL TEXT.
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
  if (typeof c.n !== "number" || !Number.isInteger(c.n) || c.n < 0) {
    return reject("cursor ordinal is not a non-negative integer");
  }

  const k = c.k;
  if (s === "newest") {
    if (typeof k !== "string" || Number.isNaN(Date.parse(k))) {
      return reject("newest cursor key is not an ISO-8601 timestamp");
    }
  } else if (typeof k !== "number" || !Number.isFinite(k)) {
    return reject(`${s} cursor key is not a finite number`);
  } else if (
    s === "popular" &&
    (!Number.isSafeInteger(k) || k < INT4_MIN || k > INT4_MAX)
  ) {
    return reject("popular cursor key is out of range for upvoteCount");
  }

  // A trending cursor without an epoch is MEANINGLESS: every row's key would drift every
  // second and the drift would be unbounded (plan D5).
  let t: string | undefined;
  if (s === "trending") {
    if (typeof c.t !== "string" || Number.isNaN(Date.parse(c.t))) {
      return reject("trending cursor is missing its pagination epoch");
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
