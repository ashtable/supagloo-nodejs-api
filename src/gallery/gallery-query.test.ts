import { describe, it, expect } from "vitest";
import { Prisma, type GallerySort } from "@supagloo/database-lib";
import { TRENDING } from "./trending";
import {
  GALLERY_PAGE_SIZE,
  GALLERY_SORT_KEY_SQL,
  buildGalleryListQuery,
  decodeCursor,
  encodeCursor,
  escapeLike,
  parseCursor,
  type GalleryCursor,
} from "./gallery-query";

// Unit tests for the gallery listing's raw-SQL builder + cursor codec (Task #39, plan
// D4/D5/D9). This is the FIRST `$queryRaw` in the api, so what is asserted here is
// CONSTRUCTION, not ordering behaviour:
//
//   - which ORDER BY key expression each sort selects (from a FIXED map — never built
//     from the request string);
//   - which keyset predicate is emitted, and that it appears iff a cursor was supplied;
//   - which values are BOUND, and — the injection guard — that NO value from the request
//     ever appears in the static SQL TEXT;
//   - the cursor codec's total, pure validation, including the sort-mismatch rejection
//     and the trending pagination epoch.
//
// The ORDERING ITSELF is deliberately NOT asserted here: it cannot be proven with a fake
// Prisma. E-G6/E-G7/E-G8 prove it against real Postgres. Recorded because a reviewer
// will ask why these tests don't assert order.
//
// NOTE on the `book` filter: there is none, and there must not be one. The `book=` query
// param was cut on 2026-07-26 (plan §5.2 superseding decision) — which books exist is a
// property of the TRANSLATION and YouVersion is the authority on it, so a facet built
// from a canon hardcoded in this repo was the wrong design. `scriptureBook` is still
// persisted, but nothing filters on it. The old U-GQ8 (`book="'"`) is therefore gone.

const NOW = new Date("2026-07-26T12:00:00.000Z");
const EPOCH = new Date("2026-07-26T09:30:00.000Z");
const SORTS: GallerySort[] = ["popular", "newest", "trending"];

/** The STATIC SQL text of a built query — the `strings` fragments only, with a sentinel
 *  where each bound value goes. The sentinel is deliberate: joining with `""` could in
 *  principle manufacture a substring that spans a placeholder boundary, which would make
 *  the injection assertion below quietly weaker than it reads. */
const staticText = (sql: Prisma.Sql) => sql.strings.join("\u0001");
/** The same text, but readable for `contains` assertions about the SQL we authored. */
const flatText = (sql: Prisma.Sql) => sql.strings.join(" ? ");

const mint = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

function build(
  over: Partial<Parameters<typeof buildGalleryListQuery>[0]> = {},
) {
  return buildGalleryListQuery({
    sort: "popular",
    cursor: null,
    now: NOW,
    pageSize: 24,
    ...over,
  });
}

// ------------------------------------------------------------------ cursor codec

describe("gallery cursor codec", () => {
  it("U-GQ1: encode/decode round-trips every sort, including the trending epoch", () => {
    const cursors: GalleryCursor[] = [
      { s: "popular", k: 42, i: "clx-popular", n: 24 },
      { s: "newest", k: "2026-07-20T08:00:00.000Z", i: "clx-newest", n: 48 },
      {
        s: "trending",
        k: 0.35355339059327373,
        i: "clx-trending",
        n: 2,
        t: EPOCH.toISOString(),
      },
    ];

    for (const cursor of cursors) {
      const encoded = encodeCursor(cursor);
      // URL-safe and OPAQUE: it travels in a query string, so no `+`, `/` or `=` may
      // appear, and the sort name must not be readable without decoding.
      expect(encoded, JSON.stringify(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encoded).not.toContain(cursor.s);

      const decoded = decodeCursor(encoded);
      expect(decoded.ok, `${cursor.s} failed to decode`).toBe(true);
      if (!decoded.ok) throw new Error("unreachable");
      expect(decoded.cursor).toEqual(cursor);
    }
  });

  it("U-GQ2: decode is TOTAL — every malformed cursor is rejected, never thrown and never partially accepted", () => {
    const rejected: Array<[string, string]> = [
      ["not base64url at all", "!!! not base64 !!!"],
      ["base64 of non-JSON", Buffer.from("not json", "utf8").toString("base64url")],
      ["base64 of a bare number", mint(42)],
      ["base64 of null", mint(null)],
      ["base64 of an array", mint([1, 2, 3])],
      ["missing k", mint({ s: "popular", i: "x", n: 1 })],
      ["missing i", mint({ s: "popular", k: 1, n: 1 })],
      ["missing n", mint({ s: "popular", k: 1, i: "x" })],
      ["k of the wrong type", mint({ s: "popular", k: {}, i: "x", n: 1 })],
      ["k null", mint({ s: "popular", k: null, i: "x", n: 1 })],
      ["i of the wrong type", mint({ s: "popular", k: 1, i: 5, n: 1 })],
      ["i empty", mint({ s: "popular", k: 1, i: "", n: 1 })],
      ["n of the wrong type", mint({ s: "popular", k: 1, i: "x", n: "1" })],
      ["n negative", mint({ s: "popular", k: 1, i: "x", n: -1 })],
      ["n fractional", mint({ s: "popular", k: 1, i: "x", n: 1.5 })],
      ["s outside the closed enum", mint({ s: "hot", k: 1, i: "x", n: 1 })],
      ["s missing", mint({ k: 1, i: "x", n: 1 })],
      // A trending cursor without an epoch is MEANINGLESS: every row's key would drift
      // every second and the drift would be unbounded (plan D5).
      ["trending with no epoch", mint({ s: "trending", k: 1, i: "x", n: 1 })],
      ["trending with a non-ISO epoch", mint({ s: "trending", k: 1, i: "x", n: 1, t: "yesterday" })],
    ];

    for (const [label, raw] of rejected) {
      const result = decodeCursor(raw);
      expect(result.ok, `expected rejection: ${label}`).toBe(false);
      if (!result.ok) expect(typeof result.reason).toBe("string");
    }
  });

  it("U-GQ3: a cursor minted under one sort is REJECTED under another — never silently reset", () => {
    const popular = encodeCursor({ s: "popular", k: 42, i: "clx", n: 24 });

    // Honouring it under `newest` would page a DIFFERENT ordering and silently skip or
    // duplicate large ranges, so this is an error (→ 400) rather than a reset.
    expect(parseCursor(popular, "newest").ok).toBe(false);
    expect(parseCursor(popular, "trending").ok).toBe(false);

    const matched = parseCursor(popular, "popular");
    expect(matched.ok).toBe(true);
    if (!matched.ok) throw new Error("unreachable");
    expect(matched.cursor).toEqual({ s: "popular", k: 42, i: "clx", n: 24 });
  });

  it("U-GQ3b: an ABSENT cursor is not an error — undefined and blank both mean page one", () => {
    for (const raw of [undefined, "", "   "]) {
      const result = parseCursor(raw, "popular");
      expect(result.ok, JSON.stringify(raw)).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.cursor).toBeNull();
    }
    // ...but garbage is still an error, so "blank is absent" has not swallowed the
    // rejection path.
    expect(parseCursor("zzz-not-a-cursor", "popular").ok).toBe(false);
  });
});

// ---------------------------------------------------------------- escapeLike (D9)

describe("escapeLike", () => {
  it("U-GQ6: escapes the three LIKE metacharacters, so a `q` of `%` matches a LITERAL percent", () => {
    expect(escapeLike("%")).toBe("\\%");
    expect(escapeLike("_")).toBe("\\_");
    expect(escapeLike("\\")).toBe("\\\\");
    expect(escapeLike("100% _sure_")).toBe("100\\% \\_sure\\_");
    // Ordinary text is untouched (no over-escaping of quotes — those are the BINDING's
    // job, not LIKE's).
    expect(escapeLike("Psalm 23:1 'shepherd'")).toBe("Psalm 23:1 'shepherd'");

    // The whole point: `%` must not become a match-everything predicate.
    const built = build({ q: "%" });
    expect(built.sql.values).toContain("%\\%%");
    expect(flatText(built.sql)).toContain("ESCAPE");
  });

  it("U-GQ7: a blank `q` emits NO search predicate at all (never a `%%` match-everything)", () => {
    for (const q of [undefined, "", "   ", "\t\n "]) {
      const built = build({ q });
      expect(flatText(built.sql), JSON.stringify(q)).not.toContain("ILIKE");
      expect(
        built.sql.values.some((v) => typeof v === "string" && v.includes("%")),
        JSON.stringify(q),
      ).toBe(false);
    }

    // ...and a real `q` DOES emit one, over all three searched columns.
    const withQ = build({ q: "shepherd" });
    const text = flatText(withQ.sql);
    expect(text).toContain("ILIKE");
    expect(text).toContain('"title"');
    expect(text).toContain('"description"');
    expect(text).toContain('"scriptureReference"');
    expect(withQ.sql.values).toContain("%shepherd%");
  });
});

// ------------------------------------------------------- the fixed ORDER BY key map

describe("GALLERY_SORT_KEY_SQL", () => {
  it("U-GQ4: the key expression is selected from a fixed map keyed by the CLOSED sort enum", () => {
    expect(Object.keys(GALLERY_SORT_KEY_SQL).sort()).toEqual([...SORTS].sort());

    const popular = GALLERY_SORT_KEY_SQL.popular(EPOCH);
    expect(flatText(popular).trim()).toBe('"upvoteCount"');
    expect(popular.values).toEqual([]);

    const newest = GALLERY_SORT_KEY_SQL.newest(EPOCH);
    expect(flatText(newest).trim()).toBe('"publishedAt"');
    expect(newest.values).toEqual([]);

    // Trending: the D3 expression. Its three constants come from TRENDING (via
    // Prisma.raw on NUMBERS only) and its instant is a BOUND parameter, never `now()`.
    const trending = GALLERY_SORT_KEY_SQL.trending(EPOCH);
    const text = flatText(trending);
    expect(text).toContain("power(");
    expect(text).toContain("EXTRACT(EPOCH FROM");
    expect(text).toContain("GREATEST(");
    expect(text).toContain('"upvoteCount"');
    expect(text).toContain('"publishedAt"');
    expect(text).toContain(String(TRENDING.voteOffset));
    expect(text).toContain(String(TRENDING.ageOffsetHours));
    expect(text).toContain(String(TRENDING.gravity));
    // `now()` inside the expression would re-score every page of one "Load more" run
    // against a different instant, which is exactly what the cursor epoch prevents.
    expect(text).not.toContain("now()");
    expect(trending.values).toEqual([EPOCH]);
  });

  it("U-GQ4b: every sort orders by (key DESC, id DESC) — the id tiebreak is what makes the keyset a TOTAL order", () => {
    for (const sort of SORTS) {
      const text = flatText(build({ sort }).sql);
      expect(text, sort).toMatch(/ORDER BY/);
      expect(text, sort).toContain('"id" DESC');
      expect((text.match(/DESC/g) ?? []).length, sort).toBeGreaterThanOrEqual(2);
    }
  });
});

// ------------------------------------------------------------------ the built query

describe("buildGalleryListQuery", () => {
  it("U-GQ5: NO value from the request reaches the SQL TEXT — it is all in `values`", () => {
    const hostileQ = `'; DROP TABLE "GalleryItem"; --`;
    const hostileId = `' OR 1=1 --`;
    const built = build({
      sort: "popular",
      q: hostileQ,
      cursor: { s: "popular", k: 7, i: hostileId, n: 3 },
    });

    const text = staticText(built.sql);
    for (const fragment of [
      hostileQ,
      hostileId,
      "DROP TABLE",
      "OR 1=1",
      "--",
    ]) {
      expect(text, `static SQL leaked: ${fragment}`).not.toContain(fragment);
    }

    // ...and every one of them is present as a BOUND value, so nothing was silently
    // dropped instead of parameterised (a builder that ignored `q` would also pass the
    // assertions above).
    expect(built.sql.values).toContain(`%${hostileQ}%`);
    expect(built.sql.values).toContain(hostileId);
    expect(built.sql.values).toContain(7);
  });

  it("U-GQ5b: the listing is hard-scoped to visibility=public — `unlisted` can never be listed", () => {
    for (const sort of SORTS) {
      const text = flatText(build({ sort }).sql);
      expect(text, sort).toContain('"visibility"');
      expect(text, sort).toContain("'public'");
      expect(text, sort).not.toContain("'unlisted'");
    }
  });

  it("U-GQ9: the LIMIT is always pageSize + 1 — the exhaustion probe row", () => {
    for (const pageSize of [1, 2, 24, GALLERY_PAGE_SIZE]) {
      const built = build({ pageSize });
      expect(flatText(built.sql)).toContain("LIMIT");
      expect(built.sql.values, `pageSize=${pageSize}`).toContain(pageSize + 1);
      expect(built.sql.values, `pageSize=${pageSize}`).not.toContain(pageSize);
    }
    expect(GALLERY_PAGE_SIZE).toBe(24);
  });

  it("U-GQ10: the keyset predicate is present IFF a cursor was supplied", () => {
    const first = build({ sort: "popular", cursor: null });
    expect(flatText(first.sql)).not.toContain(") < (");

    const next = build({
      sort: "popular",
      cursor: { s: "popular", k: 42, i: "clx-last", n: 24 },
    });
    const text = flatText(next.sql);
    // Postgres row-comparison IS the composite keyset predicate, and it is what the D1
    // composite indexes serve.
    expect(text).toContain(") < (");
    expect(text).toContain('"upvoteCount"');
    expect(next.sql.values).toContain(42);
    expect(next.sql.values).toContain("clx-last");
  });

  it("U-GQ10b: each sort's keyset predicate is built over ITS OWN key expression", () => {
    const newest = build({
      sort: "newest",
      cursor: { s: "newest", k: "2026-07-20T08:00:00.000Z", i: "clx", n: 2 },
    });
    expect(flatText(newest.sql)).toContain('"publishedAt"');
    expect(newest.sql.values).toContain("2026-07-20T08:00:00.000Z");

    const trending = build({
      sort: "trending",
      cursor: {
        s: "trending",
        k: 0.5,
        i: "clx",
        n: 2,
        t: EPOCH.toISOString(),
      },
    });
    const text = flatText(trending.sql);
    expect(text).toContain(") < (");
    expect(text).toContain("power(");
    expect(trending.sql.values).toContain(0.5);
  });

  it("U-GQ11: the trending epoch is FROZEN from the cursor when paginating, and is `now` only on page one", () => {
    // Page one: the epoch is the injected clock, and it is what the service will put in
    // the minted cursor's `t`.
    const page1 = build({ sort: "trending", cursor: null });
    expect(page1.epoch).toEqual(NOW);
    expect(page1.sql.values).toContain(NOW);

    // Page two: the epoch comes from the CURSOR, not the clock. Without this every row's
    // key drifts every second and pagination skips/duplicates unboundedly (plan D5).
    const page2 = build({
      sort: "trending",
      cursor: { s: "trending", k: 0.5, i: "clx", n: 2, t: EPOCH.toISOString() },
    });
    expect(page2.epoch).toEqual(EPOCH);
    expect(page2.sql.values).toContain(EPOCH);
    expect(page2.sql.values).not.toContain(NOW);

    // The two column sorts have no epoch to freeze — their keys are real columns — so
    // `now` must not leak into their SQL at all.
    for (const sort of ["popular", "newest"] as const) {
      const built = build({ sort });
      expect(built.sql.values, sort).not.toContain(NOW);
    }
  });

  it("U-GQ12: the query selects the id and the sort key only — the rows themselves are fetched by the typed client", () => {
    // Plan D4: raw SQL owns ORDERING + PAGINATION; row→DTO mapping stays on the typed
    // Prisma model. So this query must not try to project 16 columns.
    const text = flatText(build().sql);
    expect(text).toContain('FROM "GalleryItem"');
    expect(text).toContain('"id"');
    expect(text).not.toContain('"videoAssetKey"');
    expect(text).not.toContain('"thumbnailAssetKey"');
    expect(text).not.toContain("SELECT *");
  });
});
