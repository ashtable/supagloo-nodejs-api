import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  POSTGRES_TEXT_EXEMPT_CONTROL_CODES,
  findPostgresTextViolation,
  isPostgresSafeText,
  withPostgresSafeStrings,
} from "./postgres-text";

/**
 * U-PT — the ONE rule for "a string this api will bind as Postgres `text`".
 *
 * This suite exists because the previous pass gated three fields of the gallery cursor and
 * left a fourth field of the SAME cursor an unauthenticated 500. The rule is therefore
 * tested here, ONCE, over the whole class of inputs; the four boundaries that apply it
 * (`decodeCursor`'s `i`, `parseSearchTerm`'s `q`, the `:id` param schema, the publish body
 * schema) are then tested only for the fact that they apply it.
 *
 * Every claim below was MEASURED against the Compose Postgres 17 through the real Prisma
 * client (both `$queryRaw` with a bound parameter and a typed `findFirst`) before it was
 * written down — see the JSDoc in `postgres-text.ts` for the results table.
 */

/** The 33 code points the rule is about: C0 (U+0000–U+001F) plus DEL (U+007F). */
const C0_AND_DEL = [...Array.from({ length: 32 }, (_, i) => i), 0x7f];
const C = (...codes: number[]) => String.fromCodePoint(...codes);

describe("U-PT1: a NUL is refused — it is the one value Postgres cannot carry", () => {
  it("rejects a NUL alone, embedded, leading and trailing", () => {
    for (const value of [C(0), `a${C(0)}b`, `${C(0)}a`, `a${C(0)}`]) {
      expect(findPostgresTextViolation(value), JSON.stringify(value)).not.toBeNull();
      expect(isPostgresSafeText(value)).toBe(false);
    }
  });

  it("names the NUL in its reason, because that is the actionable half", () => {
    expect(findPostgresTextViolation(C(0))).toMatch(/control character/i);
  });
});

describe("U-PT2: the exempt set is EXACTLY tab, newline and carriage return", () => {
  // The N3 finding was that `String.prototype.trim()` also strips VT (U+000B) and FF
  // (U+000C), so testing the forbidden class AFTER trimming silently accepted them. The
  // exempt set is pinned here member by member so code and doc cannot drift again.
  it("exports the exempt set as code points, and it is {9, 10, 13}", () => {
    expect([...POSTGRES_TEXT_EXEMPT_CONTROL_CODES].sort((a, b) => a - b)).toEqual([
      0x09, 0x0a, 0x0d,
    ]);
  });

  it("accepts exactly the three exempt controls out of all 33 C0+DEL code points", () => {
    const accepted = C0_AND_DEL.filter((code) => isPostgresSafeText(C(code)));
    expect(accepted).toEqual([0x09, 0x0a, 0x0d]);
  });

  it("rejects VT and FF specifically — the two `trim()` would have hidden", () => {
    expect(isPostgresSafeText(C(0x0b))).toBe(false);
    expect(isPostgresSafeText(C(0x0c))).toBe(false);
    // ...and they are rejected in the MIDDLE of real text too, where trim cannot reach.
    expect(isPostgresSafeText(`psalm${C(0x0b)}91`)).toBe(false);
    expect(isPostgresSafeText(`psalm${C(0x0c)}91`)).toBe(false);
  });

  it("accepts the exempt three inside real text", () => {
    expect(isPostgresSafeText(`a${C(9)}b${C(10)}c${C(13)}d`)).toBe(true);
  });
});

describe("U-PT3: an unpaired UTF-16 surrogate is refused", () => {
  // MEASURED: this is NOT a 500 — Postgres never sees it, because the driver transcodes a
  // lone surrogate to U+FFFD. It is refused because the api would then have validated a
  // string the database never stored: `q` would search for something else, and a `title`
  // would be silently rewritten. Reject rather than repair, the same rule as `q`.
  it("rejects a lone high surrogate, a lone low surrogate, and either embedded", () => {
    for (const value of [
      C(0xd800),
      C(0xdbff),
      C(0xdc00),
      C(0xdfff),
      `a${C(0xd800)}b`,
      `a${C(0xdfff)}b`,
      // A high surrogate followed by another high surrogate is still unpaired.
      `${C(0xd800)}${C(0xd800)}`,
    ]) {
      expect(isPostgresSafeText(value), [...value].map((c) => c.codePointAt(0)).join(",")).toBe(
        false,
      );
    }
    expect(findPostgresTextViolation(C(0xd800))).toMatch(/surrogate/i);
  });

  it("accepts a WELL-FORMED surrogate pair — astral characters are ordinary text", () => {
    expect(isPostgresSafeText(C(0x1f600))).toBe(true);
    expect(isPostgresSafeText(`psalm ${C(0x1f64f)} 91`)).toBe(true);
    // Explicitly as the two code units, which is what JSON.parse produces.
    expect(isPostgresSafeText(`${C(0xd83d)}${C(0xde00)}`)).toBe(true);
  });
});

describe("U-PT4: everything Postgres carries UNCHANGED is accepted", () => {
  // Each of these round-tripped IDENTICALLY through `SELECT $1::text` on the real
  // database. The rule must not grow into a general-purpose "suspicious string" filter:
  // rejecting these would break real titles and real searches for no safety gain.
  it("accepts ordinary and awkward-but-valid text", () => {
    for (const value of [
      "Psalm 91:1",
      "He Who Dwells",
      "café",
      `e${C(0x301)}`,
      "100% of it",
      "snake_case",
      C(92), // a backslash — `escapeLike`'s job, not this rule's
      "' OR 1=1 --",
      '"; DROP TABLE "GalleryItem"; --',
      "$$x$$",
      C(0x80), // C1 controls: measured to round-trip identically
      C(0x9f),
      C(0xfffe), // Unicode noncharacters: valid UTF-8, carried fine
      C(0xffff),
      C(0xfffd), // an ALREADY-replaced character is just a character
      C(0xfeff), // BOM
      `a${C(0x202e)}b`, // RTL override
      "a".repeat(1_000_000), // 1 MB round-tripped identically
      "",
    ]) {
      expect(
        findPostgresTextViolation(value),
        JSON.stringify(value.slice(0, 40)),
      ).toBeNull();
    }
  });
});

describe("U-PT5: withPostgresSafeStrings gates EVERY string in a schema, found by walking", () => {
  // THE ANTI-WHACK-A-MOLE PROPERTY, and the reason this is a walk rather than a list of
  // field names: a schema that grows a new string field is gated with no change here and
  // no change at the call site. The previous pass failed exactly because the gate was a
  // per-field list and one field was left off it.
  const Nested = withPostgresSafeStrings(
    z.object({
      id: z.string().min(1),
      nested: z.object({ deep: z.string() }),
      list: z.array(z.string()),
      count: z.number(),
      flag: z.boolean(),
      optional: z.string().optional(),
    }),
  );
  const good = {
    id: "ok",
    nested: { deep: "ok" },
    list: ["ok"],
    count: 1,
    flag: true,
  };

  it("accepts a wholly safe value", () => {
    expect(Nested.safeParse(good).success).toBe(true);
  });

  it.each([
    ["top-level", { ...good, id: `a${C(0)}` }, ["id"]],
    ["nested object", { ...good, nested: { deep: C(0) } }, ["nested", "deep"]],
    ["array element", { ...good, list: ["ok", C(0x0b)] }, ["list", 1]],
    ["optional field", { ...good, optional: C(0xd800) }, ["optional"]],
  ])("rejects an unsafe string in a %s and reports its path", (_label, value, path) => {
    const res = Nested.safeParse(value);
    expect(res.success).toBe(false);
    expect(res.error!.issues.map((i) => i.path)).toEqual([path]);
  });

  it("leaves the wrapped schema's OWN rules intact and still an object schema", () => {
    // A cast/`as` that erased the object type would break `.extend()` and the Fastify
    // type provider's inference, so this is pinned.
    expect(Nested.safeParse({ ...good, id: "" }).success).toBe(false);
    expect(Nested instanceof z.ZodObject).toBe(true);
  });

  it("does not fire on non-string leaves, however hostile the number", () => {
    expect(
      withPostgresSafeStrings(z.object({ n: z.number() })).safeParse({
        n: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
  });
});
