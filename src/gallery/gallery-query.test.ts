import { describe, it, expect } from "vitest";
import { Prisma, type GallerySort } from "@supagloo/database-lib";
import { TRENDING } from "./trending";
import {
  GALLERY_MAX_ORDINAL,
  GALLERY_MAX_Q_LENGTH,
  GALLERY_PAGE_SIZE,
  GALLERY_SORT_KEY_SQL,
  buildGalleryListQuery,
  decodeCursor,
  encodeCursor,
  escapeLike,
  parseCursor,
  parseSearchTerm,
  type GalleryCursor,
} from "./gallery-query";
import {
  POSTGRES_TEXT_EXEMPT_CONTROL_CODES,
  isPostgresSafeText,
} from "../postgres-text";

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

/** C0 (U+0000–U+001F) + DEL — the 33 code points the shared text rule is about. */
const C0_AND_DEL = [...Array.from({ length: 32 }, (_, i) => i), 0x7f];

/** The STATIC SQL text of a built query — the `strings` fragments only, with a sentinel
 *  where each bound value goes. The sentinel is deliberate: joining with `""` could in
 *  principle manufacture a substring that spans a placeholder boundary, which would make
 *  the injection assertion below quietly weaker than it reads. */
const staticText = (sql: Prisma.Sql) => sql.strings.join("\u0001");
/** The same text, but readable for `contains` assertions about the SQL we authored. */
const flatText = (sql: Prisma.Sql) => sql.strings.join(" ? ");

const mint = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

/** A cursor key of the shape the sort's key expression binds: an ISO instant under
 *  `newest`, a number elsewhere. */
const keyFor = (sort: GallerySort): number | string =>
  sort === "newest" ? "2026-07-20T08:00:00.000Z" : 42;

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
      // The key's type is validated AGAINST ITS SORT, and that is what keeps a forged
      // cursor a 400 rather than a 500: the keyset predicate binds `k` with the cast its
      // sort's key expression needs (`::timestamptz` / `::integer` / `::double precision`),
      // so a `newest` key carrying a number — or a `popular` key outside int4 — would fail
      // inside Postgres's cast, after the request had already been accepted.
      ["newest key that is not a timestamp", mint({ s: "newest", k: 42, i: "x", n: 1 })],
      ["newest key that is unparseable", mint({ s: "newest", k: "last tuesday", i: "x", n: 1 })],
      ["popular key that is a string", mint({ s: "popular", k: "42", i: "x", n: 1 })],
      ["popular key beyond int4", mint({ s: "popular", k: 2_147_483_648, i: "x", n: 1 })],
      ["trending key that is a string", mint({ s: "trending", k: "0.5", i: "x", n: 1, t: EPOCH.toISOString() })],
      ["trending key that is not finite", mint({ s: "trending", k: null, i: "x", n: 1, t: EPOCH.toISOString() })],
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

  // ---------------------------------------------------------------------------------
  // The three cases below close an adversarial audit of commit `d319046`, which REFUTED
  // this file's own claim that a forged cursor could only be a 400. Every payload here was
  // driven through the real app against real Postgres with NO SESSION AT ALL and produced
  // an UNAUTHENTICATED 500 whose body carried the Prisma error code, the SQLSTATE and the
  // offending literal.
  //
  // Why the old tests missed it: U-GQ2's `"last tuesday"` is the one unparseable string V8
  // ALSO rejects, and the e2e's forged-cursor loop only sent `["zzz","","e30","%%%"]` —
  // every one of which dies at the base64 / JSON / shape gates. NO test ever sent a
  // STRUCTURALLY VALID cursor with a hostile payload through to Postgres.

  it("U-GQ2c: a structurally VALID `newest` cursor carrying a hostile timestamp is rejected — `Date.parse` is not Postgres's timestamptz parser", () => {
    // Measured against the real app + real Postgres at commit d319046, anonymously:
    const hostile: Array<[string, string]> = [
      ["a bare year", "2026"], // 500 SQLSTATE 22007
      ["a human month/year", "Jan 2000"], // 500 22007
      ["a day that does not exist", "2020-02-30T00:00:00Z"], // 500 22008
      [
        "V8's own Date#toString format",
        "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)",
      ], // 500 22007
      ["an instant outside Postgres's range", "-271821-04-20T00:00:00.000Z"], // 500 22009
      // Not observed as a 500, but the same class of "V8 accepts, Postgres would not have
      // to": the grammar, not the parser, is now the gate.
      ["a date with no time at all", "2026-07-26"],
      ["a month out of range", "2026-13-01T00:00:00Z"],
      ["an hour out of range", "2026-07-26T24:00:00Z"],
      ["a minute out of range", "2026-07-26T12:60:00Z"],
      ["no zone designator", "2026-07-26T12:00:00"],
      ["a slash-separated date", "2026/07/26 12:00:00Z"],
      ["a six-digit positive year", "+275760-09-13T00:00:00.000Z"],
      ["trailing junk", "2026-07-26T12:00:00.000Z; DROP TABLE x"],
      // The two holes the FIRST strict grammar still had, found by sweeping its own extremes
      // against real Postgres (`scratch/probe-grammar.ts`) rather than by the audit. Both were
      // unauthenticated 500s in waiting.
      ["year zero — Postgres's calendar has none (22008)", "0000-01-01T00:00:00Z"],
      ["a UTC offset past ±14:00 (22009)", "2026-07-26T12:00:00+16:00"],
      ["a nonsense offset (22009)", "2026-07-26T12:00:00+99:99"],
      ["an offset with 60 minutes", "2026-07-26T12:00:00+05:60"],
    ];

    for (const [label, k] of hostile) {
      const result = decodeCursor(mint({ s: "newest", k, i: "x", n: 1 }));
      expect(result.ok, `expected rejection: ${label} (${k})`).toBe(false);
    }
  });

  it("U-GQ2d: the trending pagination EPOCH is validated the same way — it is the second Date.parse, and it had the same hole", () => {
    // `t` is consumed as `new Date(cursor.t)` and bound as a Date, so only a JS-valid but
    // Postgres-out-of-range instant broke it — which is exactly what this one is (22009).
    const hostile = [
      "-271821-04-20T00:00:00.000Z",
      "+275760-09-13T00:00:00.000Z",
      "2026",
      "Jan 2000",
      "2020-02-30T00:00:00Z",
    ];
    for (const t of hostile) {
      const result = decodeCursor(mint({ s: "trending", k: 0.5, i: "x", n: 1, t }));
      expect(result.ok, `expected rejection: t=${t}`).toBe(false);
    }
  });

  it("U-GQ2e: the ordinal `n` must be a SAFE integer within the ordinal ceiling — an unsafe one 500s at the response serializer", () => {
    // `n` feeds `startOrdinal` and therefore `rank`, which the DTO types `z.number().int()`.
    // `Number.isInteger(9007199254740991)` is true and `Number.isInteger(1e21)` is true, so
    // the old check let both through and `sort=popular` answered
    // 500 FST_ERR_RESPONSE_SERIALIZATION. Its sibling popular-key check six lines below
    // already used `Number.isSafeInteger`; this is the same rule applied consistently.
    const hostile: Array<[string, number]> = [
      ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
      ["one past MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 2],
      ["1e21", 1e21],
      ["MAX_VALUE", Number.MAX_VALUE],
      ["one past the ordinal ceiling", GALLERY_MAX_ORDINAL + 1],
      ["Infinity", Number.POSITIVE_INFINITY],
    ];
    for (const [label, n] of hostile) {
      const result = decodeCursor(mint({ s: "popular", k: 1, i: "x", n }));
      expect(result.ok, `expected rejection: n=${label}`).toBe(false);
    }

    // ...and the ceiling itself is still a legal position, so the bound is a bound and not
    // an off-by-one that breaks deep pagination.
    expect(decodeCursor(mint({ s: "popular", k: 1, i: "x", n: GALLERY_MAX_ORDINAL })).ok).toBe(
      true,
    );
    expect(GALLERY_MAX_ORDINAL).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it("U-GQ2f: the timestamps the SERVICE actually mints still decode — the strict grammar is not over-tight", () => {
    // The service mints `k` as `Date#toISOString()` and `t` as `epoch.toISOString()`, so
    // over-rejecting here would break pagination outright. Offsets and sub-second precision
    // are accepted too: they are legal ISO-8601 instants and legal timestamptz literals.
    const accepted = [
      new Date().toISOString(),
      "2026-07-26T12:00:00.000Z",
      "2026-07-26T12:00:00Z",
      "2026-07-26T12:00:00.123456Z",
      "2028-02-29T00:00:00.000Z", // a REAL leap day
      "2026-07-26T12:00:00+05:30",
      "2026-07-26T12:00:00.000-08:00",
      "2026-07-26T12:00:00+14:00", // ISO-8601's own maximum, and a real zone (Line Islands)
      "2026-07-26T12:00:00-14:00",
      "0001-01-01T00:00:00.000Z", // the year floor: 1, not 0000
      "9999-12-31T23:59:59.999Z",
    ];

    for (const k of accepted) {
      expect(decodeCursor(mint({ s: "newest", k, i: "x", n: 1 })).ok, k).toBe(true);
      expect(
        decodeCursor(mint({ s: "trending", k: 0.5, i: "x", n: 1, t: k })).ok,
        `t=${k}`,
      ).toBe(true);
    }
    // …and the leap-day check is real: 2026-02-29 does not exist.
    expect(decodeCursor(mint({ s: "newest", k: "2026-02-29T00:00:00.000Z", i: "x", n: 1 })).ok).toBe(
      false,
    );
  });

  it("U-GQ2g: the cursor's `i` is gated by the SAME rule as every other request string — it is the FOURTH bound parameter in the keyset predicate", () => {
    // N1. The previous pass gated `k`, `t` and `n` and left `i` checked only for
    // typeof/emptiness — so `{"s":"newest","k":"…","i":"\u0000","n":1}` was STILL an
    // unauthenticated 500 (P2010 → SQLSTATE 22021) on ALL THREE sorts, and the e2e test
    // whose title claimed the class was closed hardcoded `i: "zzz"` in all eleven payloads.
    //
    // `i` is bound in `(<key>, "id") < ($k, $i)`. It is not a special case; it is the same
    // rule, which is why this drives the whole class rather than one example of it.
    //
    // The list is enumerated LITERALLY and never filtered by the predicate under test. An
    // earlier draft wrote `.filter(v => !isPostgresSafeText(v))` and passed VACUOUSLY against
    // a stub that accepted everything, because the list came out EMPTY — the same failure
    // mode as an e2e whose title claims a class it never drives.
    const EXEMPT_CODES = [0x09, 0x0a, 0x0d];
    const hostile = [
      ...C0_AND_DEL.filter((code) => !EXEMPT_CODES.includes(code)).map((code) =>
        String.fromCodePoint(code),
      ),
      `a${String.fromCodePoint(0)}b`,
      `clx${String.fromCodePoint(0)}`,
      `${String.fromCodePoint(0)}clx`,
      String.fromCodePoint(0xd800),
      `clx${String.fromCodePoint(0xdfff)}`,
    ];
    // 33 C0+DEL code points less the 3 exempt, plus 5 composite cases.
    expect(hostile).toHaveLength(35);
    // ...and the shared predicate agrees the whole list is unsafe, so the two gates cannot
    // drift apart without one of these two assertions failing.
    expect(hostile.filter((v) => isPostgresSafeText(v))).toEqual([]);

    for (const sort of SORTS) {
      for (const i of hostile) {
        const result = decodeCursor(
          mint({
            s: sort,
            k: keyFor(sort),
            i,
            n: 1,
            ...(sort === "trending" ? { t: EPOCH.toISOString() } : {}),
          }),
        );
        expect(
          result.ok,
          `expected rejection: sort=${sort} i=U+${i.codePointAt(0)!.toString(16)}`,
        ).toBe(false);
      }
    }

    // ...and a real cuid — plus the exempt whitespace and every LIKE metacharacter — still
    // decodes, because ids are compared for EQUALITY and this gate is about what Postgres
    // can carry, not about what an id looks like. (A cuid-shaped regex was rejected here on
    // purpose: it would couple every route to the id GENERATOR, and it would turn an
    // unknown id from a uniform 404 into a 400.)
    for (const i of ["cms1rypc40004q2lg6gcxlivg", "no-such-item", "a\tb", "100%_\\"]) {
      expect(decodeCursor(mint({ s: "popular", k: 42, i, n: 1 })).ok, i).toBe(true);
    }
  });

  it("U-GQ2h: the `popular` key's rejection says WHY it was rejected — a non-integer is not 'out of range'", () => {
    // N4. Both a fractional key and an int4 overflow used to answer "out of range for
    // upvoteCount", which sends a client hunting for a bound when the real problem is that
    // `upvoteCount` is an integer column. An error message that misdescribes the fault is a
    // support cost, and it is free to fix.
    const reasonFor = (k: unknown): string => {
      const result = decodeCursor(mint({ s: "popular", k, i: "clx", n: 1 }));
      if (result.ok) throw new Error(`expected rejection for k=${String(k)}`);
      return result.reason;
    };

    for (const k of [1.5, -0.5, 1e-320, 0.1]) {
      expect(reasonFor(k), `k=${k}`).toMatch(/integer/i);
      expect(reasonFor(k), `k=${k}`).not.toMatch(/out of range/i);
    }
    for (const k of [2_147_483_648, -2_147_483_649, 1e21]) {
      expect(reasonFor(k), `k=${k}`).toMatch(/range/i);
    }
    // The int4 bounds themselves are still legal keys.
    expect(decodeCursor(mint({ s: "popular", k: 2_147_483_647, i: "x", n: 1 })).ok).toBe(true);
    expect(decodeCursor(mint({ s: "popular", k: -2_147_483_648, i: "x", n: 1 })).ok).toBe(true);
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

  it("U-GQ13: `q` is REJECTED for a NUL/control byte and for exceeding its length bound — never silently repaired", () => {
    // THE CHEAPEST 500 THE AUDIT FOUND on the whole surface: no cursor, no session, one
    // query parameter. `q` was a bare `z.string().optional()` and `escapeLike` only handles
    // `\ % _`, so `GET /v1/gallery?q=%00` reached Postgres and answered
    // `500 … 22021 invalid byte sequence for encoding "UTF8": 0x00` — anonymously.
    for (const [label, q] of [
      ["a lone NUL", "\u0000"],
      ["an embedded NUL", "a\u0000b"],
      ["a NUL behind trimmable space", "  \u0000  "],
      ["a bell", "a\u0007b"],
      ["a vertical tab", "a\u000Bb"],
      ["an escape", "a\u001Bb"],
      ["a DEL", "a\u007Fb"],
    ] as Array<[string, string]>) {
      const result = parseSearchTerm(q);
      expect(result.ok, `expected rejection: ${label}`).toBe(false);
    }

    // REJECT, not strip. Stripping would make `q=%00` behave exactly like a BLANK `q` — a
    // match-everything listing handed back in answer to a hostile input — and would report
    // hits for a string the caller never sent. Truncating an over-long `q` is the same lie.
    const tooLong = "a".repeat(GALLERY_MAX_Q_LENGTH + 1);
    expect(parseSearchTerm(tooLong).ok).toBe(false);
    // The bound itself is a legal query, so this is a bound and not an off-by-one.
    expect(parseSearchTerm("a".repeat(GALLERY_MAX_Q_LENGTH)).ok).toBe(true);
    // It has to actually BOUND the ILIKE work: today a 12 000-char `q` was accepted and
    // bounded only ACCIDENTALLY, by Node's 16 KB request-line limit.
    expect(GALLERY_MAX_Q_LENGTH).toBeLessThanOrEqual(1_000);

    // Tab / newline / CR survive: they are whitespace, they are plausible in a paste, and
    // Postgres carries them fine. Only the non-whitespace controls are refused.
    for (const q of ["a\tb", "a\nb", "a\r\nb"]) {
      expect(parseSearchTerm(q).ok, JSON.stringify(q)).toBe(true);
    }
  });

  it("U-GQ13c: the control-character check runs BEFORE `.trim()`, so VT and FF cannot collapse into a blank `q`", () => {
    // N3. `String.prototype.trim()` strips FIVE whitespace controls — tab, LF, VT, FF, CR —
    // but the exempt set is only THREE. Testing the forbidden class after trimming therefore
    // deleted the evidence: `q=%0B` and `q=%0C` trimmed to "" and were answered with a
    // 200 MATCH-EVERYTHING LISTING, which is precisely the outcome "reject, do not repair"
    // exists to prevent. `ab` was already rejected (trim cannot reach the middle of a
    // string), which is why the existing test passed and the bug survived.
    const CH = (code: number) => String.fromCodePoint(code);
    for (const [label, q] of [
      ["a lone VT", CH(0x0b)],
      ["a lone FF", CH(0x0c)],
      ["a leading VT", `${CH(0x0b)}psalm`],
      ["a trailing VT", `psalm${CH(0x0b)}`],
      ["a leading FF", `${CH(0x0c)}psalm`],
      ["a trailing FF", `psalm${CH(0x0c)}`],
      ["VT and FF only", `${CH(0x0b)}${CH(0x0c)}`],
      ["a VT behind trimmable space", `  ${CH(0x0b)}  `],
      ["a lone NUL", CH(0x00)],
      ["a trailing NUL", `psalm${CH(0x00)}`],
      ["a lone DEL", CH(0x7f)],
    ] as Array<[string, string]>) {
      const result = parseSearchTerm(q);
      expect(result.ok, `expected rejection: ${label}`).toBe(false);
    }

    // The exempt set is EXACTLY {tab, LF, CR} and it is the shared module's set, not a
    // second copy of it. Anything trimmable-but-exempt still means "absent".
    expect([...POSTGRES_TEXT_EXEMPT_CONTROL_CODES].sort((a, b) => a - b)).toEqual([
      0x09, 0x0a, 0x0d,
    ]);
    for (const q of ["\t", "\n", "\r", "\r\n", " \t\n\r "]) {
      const result = parseSearchTerm(q);
      expect(result.ok, JSON.stringify(q)).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.q, JSON.stringify(q)).toBeUndefined();
    }

    // Whichever member of C0+DEL is not exempt is refused, wherever it sits in the string.
    // The expected outcome comes from a LITERAL set, not from the module's own constant, so
    // this cannot agree with a wrong implementation.
    for (const code of C0_AND_DEL) {
      const ch = String.fromCodePoint(code);
      const exempt = [0x09, 0x0a, 0x0d].includes(code);
      for (const q of [ch, `a${ch}`, `${ch}a`, `a${ch}b`]) {
        expect(parseSearchTerm(q).ok, `U+${code.toString(16)} in ${JSON.stringify(q)}`).toBe(
          exempt,
        );
      }
    }
  });

  it("U-GQ13b: blank is ABSENT, and an accepted `q` passes through UNCHANGED", () => {
    // A UI that always appends `q=` must not 400, and blank must not become `%%`.
    for (const q of [undefined, "", "   ", "\t\n "]) {
      const result = parseSearchTerm(q);
      expect(result.ok, JSON.stringify(q)).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.q, JSON.stringify(q)).toBeUndefined();
    }

    // LIKE metacharacters and SQL punctuation are NOT this function's business — they are
    // `escapeLike`'s and the binding's respectively. It must not double up as a sanitiser.
    for (const q of ["%", "_", "\\", `'; DROP TABLE "GalleryItem"; --`, "Psalm 23:1"]) {
      const result = parseSearchTerm(q);
      expect(result.ok, q).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.q, q).toBe(q);
    }
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

  it("U-GQ4c: the ORDER BY key is the FIXED output alias — the request's `sort` string never reaches the SQL TEXT", () => {
    // THE INVARIANT THE MODULE HEADER CALLS NON-NEGOTIABLE, and until now nothing held it.
    // An adversarial audit's mutation M1c replaced this query's `ORDER BY "sortKey"` with
    // `ORDER BY ${Prisma.raw(String(rawOrder))}`, where `rawOrder` derives from the request's
    // `sort` — the request string interpolated straight into SQL TEXT — and the whole suite
    // stayed green (79/79 unit, 25/25 e2e). Not exploitable today, because `GallerySortSchema`
    // is a closed Zod enum, but "not exploitable because a schema in another file happens to
    // be closed" is not the same as "the ORDER BY key cannot come from the request".
    //
    // U-GQ5 only passes a hostile `q` and a hostile cursor `i`, both of which ARE properly
    // bound; neither can see the ORDER BY clause at all.
    for (const cursor of [
      null,
      { s: "popular" as const, k: 42, i: "clx", n: 3 },
    ]) {
      for (const sort of SORTS) {
        const scoped =
          cursor === null ? null : { ...cursor, s: sort, k: keyFor(sort) };
        const text = staticText(build({ sort, cursor: scoped as never }).sql);
        const where = `${sort} cursor=${cursor === null ? "none" : "yes"}`;

        // The ordering key is an ALIAS the SELECT defined — a constant of this module.
        expect(text, where).toContain('ORDER BY "sortKey" DESC, "id" DESC');
        // …and no sort NAME appears anywhere in the static SQL. `Prisma.raw`-ing the request
        // value in would put one there whichever clause it landed in.
        for (const name of SORTS) {
          expect(text.toLowerCase(), `${where} leaked the sort name ${name}`).not.toContain(
            name,
          );
        }
      }
    }

    // The map is the ONLY thing indexed by the request value, and it is total over the enum:
    // an out-of-enum sort therefore cannot select an expression at all (it throws before any
    // SQL exists), rather than emitting itself.
    expect(() =>
      build({ sort: `popular"; DROP TABLE "GalleryItem"; --` as GallerySort }),
    ).toThrow();
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
    // DEEP on the positive side, IDENTITY on the negative side, and the asymmetry is
    // load-bearing. The paginating epoch is reconstructed from the cursor's ISO string, so it
    // can never be the same Date OBJECT as this file's `EPOCH` — and `toContain` compares
    // objects by reference. The negative check below stays reference-based on purpose: `NOW`
    // is the very object handed to the builder as its clock, so its ABSENCE from `values` is
    // exactly the proof that the clock was not bound.
    expect(page2.sql.values).toEqual(expect.arrayContaining([EPOCH]));
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
