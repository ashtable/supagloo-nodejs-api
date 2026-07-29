import { describe, it, expect } from "vitest";
import * as dbLib from "@supagloo/database-lib";
import { buildBlankManifest } from "@supagloo/database-lib";
import { ProjectScriptureSchema, seedManifestScripture } from "./project-scripture";

/**
 * The forward-declared `scripture` shape (feature 2) — and its pin against db-lib.
 *
 * `project-scripture.ts`'s docblock claimed this file held the two schemas against each
 * other. It did not exist, so the claim was a citation of a proof nobody had written: the
 * file says "byte-identical to db-lib's `ManifestScriptureSchema`, pinned by
 * `project-scripture.test.ts`", and a reader had no way to know the pin was imaginary.
 *
 * The equivalence check below is SELF-ENABLING rather than an `it.todo`. db-lib at the
 * currently-pinned SHA does not export `ManifestScriptureSchema` at all, so the check
 * reads the barrel at runtime: while the export is absent it asserts exactly that (and
 * says why, so a reader is not misled into thinking a comparison ran), and the moment the
 * submodule bump lands it starts comparing for real — with no edit to remember to make.
 * A `todo` would have gone green-and-silent through the very release it exists to guard.
 */

const VALID = {
  reference: "Psalm 121",
  translation: "ASV",
  language: "en",
  passageId: "PSA.121",
};

describe("ProjectScriptureSchema", () => {
  it("parses the full block and keeps every field", () => {
    expect(ProjectScriptureSchema.parse(VALID)).toEqual(VALID);
  });

  it("accepts the minimal block — language and passageId are optional", () => {
    const minimal = { reference: "Psalm 121", translation: "ASV" };
    expect(ProjectScriptureSchema.parse(minimal)).toEqual(minimal);
  });

  it("REJECTS a malformed block rather than silently dropping it", () => {
    // The whole reason this schema is declared locally: db-lib's request schema is a plain
    // `z.object`, which strips unknown keys in silence. A 400 the wizard can see beats a
    // 201 whose passage evaporated.
    expect(ProjectScriptureSchema.safeParse({ translation: "ASV" }).success).toBe(false);
    expect(
      ProjectScriptureSchema.safeParse({ ...VALID, reference: "" }).success,
    ).toBe(false);
    expect(
      ProjectScriptureSchema.safeParse({ ...VALID, translation: "" }).success,
    ).toBe(false);
    expect(
      ProjectScriptureSchema.safeParse({ ...VALID, passageId: "" }).success,
    ).toBe(false);
  });

  it("accepts an ARBITRARY licensed translation abbreviation, not an enum", () => {
    // §9-Q10 / task #58: the licensed set is a property of the language and is validated
    // against the live YouVersion collection, never enum-gated at a wire boundary.
    expect(
      ProjectScriptureSchema.parse({ ...VALID, translation: "NVI" }).translation,
    ).toBe("NVI");
  });
});

describe("seedManifestScripture", () => {
  it("is BYTE-IDENTICAL to buildBlankManifest() when no passage was picked", () => {
    // The claim `project-scripture.ts` makes about the skip path. Serialized, because
    // "byte-identical" is a statement about what lands in the user's git repo — an extra
    // `scripture: undefined` key would deep-equal but not serialize equal.
    const blank = buildBlankManifest();
    expect(JSON.stringify(seedManifestScripture(blank, undefined))).toBe(
      JSON.stringify(buildBlankManifest()),
    );
  });

  it("seeds the passage at PROJECT level, leaving scenes empty", () => {
    const out = seedManifestScripture(buildBlankManifest(), VALID);
    expect((out as unknown as { scripture: unknown }).scripture).toEqual(VALID);
    // Project-level, not a synthesized first scene: a scene would mean inventing a script
    // and a visual prompt the user never asked for, and the first storyboard generation
    // replaces `scenes` wholesale anyway.
    expect(out.scenes).toEqual([]);
    expect(out.manifestVersion).toBe(1);
  });

  it("does not mutate the manifest it was given", () => {
    const blank = buildBlankManifest();
    seedManifestScripture(blank, VALID);
    expect("scripture" in blank).toBe(false);
  });
});

describe("the pin against db-lib", () => {
  it("matches db-lib's ManifestScriptureSchema once the submodule bump publishes it", () => {
    const published = (dbLib as unknown as Record<string, unknown>)
      .ManifestScriptureSchema;

    if (published === undefined) {
      // Pre-bump. Asserted rather than skipped so this states a true fact about the tree
      // it is running in, and so `project-scripture.ts`'s "DELETE AT THE db-lib BUMP" note
      // has something that actually changes when the bump lands.
      expect(
        (dbLib as unknown as Record<string, unknown>).ProjectManifestSchema,
      ).toBeDefined();
      return;
    }

    // Post-bump: the two must accept and reject the same things. Compared behaviourally
    // rather than by `.shape` key names, because equal keys with unequal validators is
    // exactly the drift a forward declaration is at risk of.
    const theirs = published as typeof ProjectScriptureSchema;
    const cases: unknown[] = [
      VALID,
      { reference: "Psalm 121", translation: "ASV" },
      { reference: "Psalm 121", translation: "NVI", language: "es" },
      { translation: "ASV" },
      { reference: "" },
      { ...VALID, reference: "" },
      { ...VALID, translation: "" },
      { ...VALID, passageId: "" },
      { ...VALID, language: "" },
    ];
    for (const c of cases) {
      const mine = ProjectScriptureSchema.safeParse(c);
      const other = theirs.safeParse(c);
      expect(other.success, JSON.stringify(c)).toBe(mine.success);
      if (mine.success && other.success) {
        expect(other.data, JSON.stringify(c)).toEqual(mine.data);
      }
    }
  });
});
