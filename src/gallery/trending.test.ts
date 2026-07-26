import { describe, it, expect } from "vitest";
import { TRENDING, sortByTrendingDesc, trendingScore } from "./trending";

// Unit tests for the TRENDING ordering twin (Task #39, plan D3). `trendingScore` is a
// pure TS mirror of the SQL expression the gallery listing sorts by, built from the SAME
// `TRENDING` constants the SQL fragment is generated from, so the two cannot drift in
// their constants:
//
//   score = (upvoteCount + voteOffset) / (GREATEST(ageHours, 0) + ageOffsetHours) ^ gravity
//
// The split is deliberate and is the honest one: a JS unit test proves NOTHING about
// Postgres's `power()`, so what lives here are the ORDERING PROPERTIES (P1-P10 from the
// plan), asserted as properties over fixture sets with an INJECTED `now` — never a golden
// number, never `new Date()`. The "the SQL agrees with this twin" claim is one e2e test
// against real Postgres (E-G7).
//
// Every fixture is expressed as (upvoteCount, ageHours) relative to one fixed NOW, so a
// reader can check the intended ordering by hand.

const NOW = new Date("2026-07-26T12:00:00.000Z");
const HOUR_MS = 3_600_000;

interface Row {
  id: string;
  upvoteCount: number;
  publishedAt: Date;
}

/** A row `ageHours` old relative to {@link NOW}. Negative age ⇒ published in the FUTURE. */
function row(id: string, upvoteCount: number, ageHours: number): Row {
  return {
    id,
    upvoteCount,
    publishedAt: new Date(NOW.getTime() - ageHours * HOUR_MS),
  };
}

const score = (r: Row) => trendingScore(r, NOW);
const ids = (rows: readonly Row[]) => rows.map((r) => r.id);

/**
 * The P5 fixture set, and the reason it exists: it is chosen so the three orderings are
 * PAIRWISE DIFFERENT. Hand-computed with the plan's constants (voteOffset 1,
 * ageOffsetHours 2, gravity 1.5):
 *
 *   E  v=500 age=3h   → 501 / 5^1.5   ≈ 44.81
 *   C  v=0   age=0h   →   1 / 2^1.5   ≈  0.3536
 *   B  v=10  age=10h  →  11 / 12^1.5  ≈  0.2646
 *   A  v=100 age=200h → 101 / 202^1.5 ≈  0.0352
 *
 *   trending: E C B A      popular: E A B C      newest: C E B A
 */
const THIRD_ORDERING_SET: Row[] = [
  row("A", 100, 200),
  row("B", 10, 10),
  row("C", 0, 0),
  row("E", 500, 3),
];
const POPULAR_ORDER = ["E", "A", "B", "C"];
const NEWEST_ORDER = ["C", "E", "B", "A"];

describe("trendingScore — P1/P2 monotonicity", () => {
  it("U-TR1 (P1): with publishedAt equal, strictly more upvotes ⇒ a strictly higher score", () => {
    const votes = [0, 1, 2, 5, 50, 5_000];
    let previous = -Infinity;
    for (const v of votes) {
      const s = score(row(`v${v}`, v, 24));
      expect(s).toBeGreaterThan(previous);
      previous = s;
    }
  });

  it("U-TR2 (P2): with upvotes equal, a strictly newer publishedAt ⇒ a strictly higher score", () => {
    const older = score(row("older", 7, 48));
    const newer = score(row("newer", 7, 12));
    expect(newer).toBeGreaterThan(older);
    // ...and the same holds one second apart, so the decay is continuous rather than
    // bucketed into hours (an `Math.floor(ageHours)` regression would tie these).
    const a = trendingScore({ upvoteCount: 7, publishedAt: new Date(NOW.getTime() - 60_000) }, NOW);
    const b = trendingScore({ upvoteCount: 7, publishedAt: new Date(NOW.getTime() - 61_000) }, NOW);
    expect(a).toBeGreaterThan(b);
  });
});

describe("trendingScore — P3/P4 decay shape", () => {
  it("U-TR3 (P3): for fixed votes the score STRICTLY decreases in age across [0, 10000] hours — no plateau, no kink", () => {
    const ages = [
      0, 0.001, 0.25, 0.5, 1, 2, 3, 6, 12, 24, 48, 100, 250, 500, 1_000, 2_500,
      5_000, 7_500, 10_000,
    ];
    let previous = Infinity;
    for (const age of ages) {
      const s = score(row(`age${age}`, 5, age));
      expect(Number.isFinite(s), `age=${age} produced ${s}`).toBe(true);
      expect(s, `age=${age} did not decrease (previous ${previous})`).toBeLessThan(
        previous,
      );
      expect(s).toBeGreaterThan(0);
      previous = s;
    }
  });

  it("U-TR4 (P4): two ZERO-vote items with different publishedAt get DIFFERENT scores (the voteOffset property)", () => {
    const fresh = score(row("fresh", 0, 1));
    const stale = score(row("stale", 0, 100));
    expect(fresh).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(0);
    expect(fresh).not.toBe(stale);
    expect(fresh).toBeGreaterThan(stale);
    // The whole point: without the numerator offset every 0-vote row scores exactly 0
    // and the sort collapses onto the id tiebreak.
    expect(sortByTrendingDesc([row("stale", 0, 100), row("fresh", 0, 1)], NOW).map((r) => r.id))
      .toEqual(["fresh", "stale"]);
  });
});

describe("trendingScore — P5 trending is a genuinely third ordering", () => {
  it("U-TR5 (P5): the trending order differs from BOTH the popular order and the newest order", () => {
    const trending = ids(sortByTrendingDesc(THIRD_ORDERING_SET, NOW));
    expect(trending).toEqual(["E", "C", "B", "A"]);

    // Sanity-check the two reference orderings against the fixture itself, so the
    // comparison below cannot silently degrade into comparing against a stale literal.
    const byVotes = [...THIRD_ORDERING_SET].sort((a, b) => b.upvoteCount - a.upvoteCount);
    const byDate = [...THIRD_ORDERING_SET].sort(
      (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
    );
    expect(ids(byVotes)).toEqual(POPULAR_ORDER);
    expect(ids(byDate)).toEqual(NEWEST_ORDER);

    // This is the assertion that catches gravity→0 (trending ≡ popular) and a
    // voteOffset-dominated formula (trending ≡ newest).
    expect(trending).not.toEqual(POPULAR_ORDER);
    expect(trending).not.toEqual(NEWEST_ORDER);
  });
});

describe("trendingScore — P6/P7 boundary ages", () => {
  it("U-TR6 (P6): publishedAt === now yields a FINITE, POSITIVE score (no divide-by-zero, no Infinity)", () => {
    for (const votes of [0, 1, 999]) {
      const s = trendingScore({ upvoteCount: votes, publishedAt: NOW }, NOW);
      expect(Number.isFinite(s)).toBe(true);
      expect(Number.isNaN(s)).toBe(false);
      expect(s).toBeGreaterThan(0);
    }
  });

  it("U-TR7 (P7): a publishedAt 5h in the FUTURE is clamped to age 0 — never NaN, never negative, never Infinity", () => {
    const future = row("future", 3, -5); // 5 hours ahead of NOW
    const atZero = trendingScore({ upvoteCount: 3, publishedAt: NOW }, NOW);
    const s = trendingScore(future, NOW);

    expect(Number.isNaN(s)).toBe(false);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeGreaterThan(0);
    // Exactly equal to age 0 — the clamp, not merely "close to".
    expect(s).toBe(atZero);
    // An unclamped formula would divide by (-5 + 2) = -3 raised to 1.5 → NaN in JS and
    // an error in Postgres, so an even more extreme skew must clamp too.
    const wayAhead = trendingScore({ upvoteCount: 3, publishedAt: new Date(NOW.getTime() + 1_000 * HOUR_MS) }, NOW);
    expect(wayAhead).toBe(atZero);
  });
});

describe("trendingScore — P8 the decay actually bites", () => {
  it("U-TR8 (P8): a newer item beats an older MORE-upvoted one, and an older item with enough votes beats a brand-new one", () => {
    // (a) newer wins despite 100 fewer votes
    const fresh = row("fresh", 0, 0);
    const oldPopular = row("old-popular", 100, 200);
    expect(score(fresh)).toBeGreaterThan(score(oldPopular));
    expect(ids(sortByTrendingDesc([oldPopular, fresh], NOW))).toEqual([
      "fresh",
      "old-popular",
    ]);

    // (b) ...and the reverse: 500 votes at 3h still beats a 0-vote item at age 0, so the
    // formula is not simply "newest wins".
    const bigAndRecent = row("big", 500, 3);
    expect(score(bigAndRecent)).toBeGreaterThan(score(fresh));
    expect(ids(sortByTrendingDesc([fresh, bigAndRecent], NOW))).toEqual([
      "big",
      "fresh",
    ]);
  });
});

describe("sortByTrendingDesc — P9/P10 ordering guarantees", () => {
  it("U-TR9 (P9): the order is deterministic for a given (rows, now), and ties break on id DESC", () => {
    const shuffled = [
      THIRD_ORDERING_SET[2],
      THIRD_ORDERING_SET[0],
      THIRD_ORDERING_SET[3],
      THIRD_ORDERING_SET[1],
    ];
    // Input order must not matter, and repeat calls must agree.
    expect(ids(sortByTrendingDesc(THIRD_ORDERING_SET, NOW))).toEqual(
      ids(sortByTrendingDesc(shuffled, NOW)),
    );
    expect(ids(sortByTrendingDesc(shuffled, NOW))).toEqual(
      ids(sortByTrendingDesc(shuffled, NOW)),
    );

    // Exact ties: identical votes AND identical publishedAt ⇒ id DESC, matching the
    // SQL's `ORDER BY <key> DESC, "id" DESC`. Asserted from both input orders so a
    // sort that merely preserved input order would fail one of them.
    const aaa = row("item-aaa", 4, 9);
    const zzz = row("item-zzz", 4, 9);
    expect(score(aaa)).toBe(score(zzz));
    expect(ids(sortByTrendingDesc([aaa, zzz], NOW))).toEqual(["item-zzz", "item-aaa"]);
    expect(ids(sortByTrendingDesc([zzz, aaa], NOW))).toEqual(["item-zzz", "item-aaa"]);
  });

  it("U-TR10 (P10): sorting is a PERMUTATION — nothing dropped, nothing duplicated, input untouched", () => {
    const input = [
      ...THIRD_ORDERING_SET,
      row("dup-key-1", 4, 9),
      row("dup-key-2", 4, 9),
      row("zero", 0, 5_000),
    ];
    const snapshot = ids(input);

    const sorted = sortByTrendingDesc(input, NOW);

    expect(sorted).toHaveLength(input.length);
    expect([...ids(sorted)].sort()).toEqual([...snapshot].sort());
    expect(new Set(ids(sorted)).size).toBe(input.length);
    // Pure: the caller's array is not reordered in place.
    expect(ids(input)).toEqual(snapshot);
  });
});

describe("TRENDING constants", () => {
  it("U-TR11: the three constants are exactly {voteOffset:1, ageOffsetHours:2, gravity:1.5} — a deliberate change-detector", () => {
    // This IS a change-detector, on purpose. The constants are a design decision (plan
    // D3: HN's gravity form, +1 numerator so 0-vote items still order by age, +2h so a
    // one-minute-old item with one vote cannot own the page). Changing them must be a
    // deliberate act accompanied by a plan-doc update — never a silent tweak — and the
    // SAME object generates the SQL fragment, so this pins both sides at once.
    expect(TRENDING).toEqual({ voteOffset: 1, ageOffsetHours: 2, gravity: 1.5 });
  });
});
