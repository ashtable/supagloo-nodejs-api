/**
 * The `sort=trending` score, and its pure TypeScript twin (Task #39, plan D3).
 *
 * design-delta §2.7 binds only three things about trending: it is computed **at query
 * time**, in **SQL**, over exactly `upvoteCount` + `publishedAt`, with **no stored score
 * column in v1**. It names no constant, gravity, half-life or tie-break — so the shape
 * below is a decision, recorded here rather than buried in a SQL string.
 *
 * The form is Hacker News's gravity curve with an INJECTED instant:
 *
 * ```
 *   score = (upvoteCount + voteOffset) / (max(ageHours, 0) + ageOffsetHours) ^ gravity
 * ```
 *
 * Each constant earns its place:
 *   - **`voteOffset: 1`** — without it every zero-vote item scores exactly 0 and the whole
 *     sort collapses onto the `id` tiebreak. With it a fresh unvoted item still orders by
 *     age, which is what "trending" has to mean on a young gallery.
 *   - **`ageOffsetHours: 2`** — HN's classic offset. It stops the score exploding as age →
 *     0 and damps the first two hours, so one vote on a one-minute-old item cannot own the
 *     page.
 *   - **`gravity: 1.5`** — HN's constant: aggressive early decay, gentle later (a
 *     same-vote score halves after ≈1.2 h at t=0 and ≈39 h at t=24 h).
 *   - **the `max(ageHours, 0)` clamp** — absorbs clock skew and a `publishedAt` in the
 *     future, which would otherwise drive the denominator below 2 and, at extreme skew,
 *     raise a negative base to a fractional power: `NaN` in JS, an ERROR in Postgres.
 *
 * `now` is a parameter, never `Date.now()` here and never `now()` in the SQL. That is
 * load-bearing twice over: it makes the score testable, and it lets the cursor freeze one
 * pagination epoch (plan D5) so the keys do not drift between pages of one "Load more".
 *
 * WHY A TWIN EXISTS. `GALLERY_SORT_KEY_SQL.trending` in `./gallery-query` is generated
 * from the SAME {@link TRENDING} object (via `Prisma.raw` on the NUMBERS only), so the two
 * cannot drift in their constants. The ORDERING PROPERTIES are unit-tested against this
 * twin; the "the SQL agrees with the twin" claim is one e2e against real Postgres (E-G7).
 * That split is the honest one: a JS unit test proves nothing about Postgres's `power()`,
 * and an e2e cannot enumerate ten properties cheaply.
 */
export const TRENDING = {
  voteOffset: 1,
  ageOffsetHours: 2,
  gravity: 1.5,
} as const;

const HOUR_MS = 3_600_000;

/** The two ordering inputs — the only two columns design-delta §2.7 allows. */
export interface TrendingInput {
  upvoteCount: number;
  publishedAt: Date;
}

/**
 * The trending score of one row at instant `now`. Pure: no clock read, no env read.
 *
 * Always finite and strictly positive — the age clamp keeps the base at or above
 * `ageOffsetHours`, so there is no divide-by-zero at age 0 and no negative base under
 * clock skew.
 */
export function trendingScore(row: TrendingInput, now: Date): number {
  const ageHours = Math.max(
    (now.getTime() - row.publishedAt.getTime()) / HOUR_MS,
    0,
  );
  return (
    (row.upvoteCount + TRENDING.voteOffset) /
    Math.pow(ageHours + TRENDING.ageOffsetHours, TRENDING.gravity)
  );
}

/**
 * Sort rows by trending score DESC, breaking ties on `id` DESC — exactly the SQL's
 * `ORDER BY <key> DESC, "id" DESC`. The `id` tiebreak is what makes the ordering a TOTAL
 * order, which is what makes the keyset cursor in `./gallery-query` correct.
 *
 * Returns a NEW array; the caller's array is never reordered in place.
 */
export function sortByTrendingDesc<T extends TrendingInput & { id: string }>(
  rows: readonly T[],
  now: Date,
): T[] {
  return [...rows].sort((a, b) => {
    const delta = trendingScore(b, now) - trendingScore(a, now);
    if (delta !== 0) return delta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
