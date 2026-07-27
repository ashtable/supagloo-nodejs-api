import { describe, it, expect } from "vitest";
import {
  GalleryMakingOfSchema,
  type ManifestScene,
  type ProjectManifest,
} from "@supagloo/database-lib";
import { buildMakingOfSnapshot, MAX_SNAPSHOT_SCENES } from "./making-of";

// Unit tests for the PURE manifest -> `GalleryItem.makingOf` snapshot builder (plan
// slice C3, Turn 16a). No I/O, no DB, no clock of its own — `now` is injected, so
// `capturedAt` is assertable rather than merely "a timestamp".
//
// The property this whole file exists to hold is U-MOB7: whatever goes in, what comes
// out either PARSES as `GalleryMakingOfSchema` or is `null`. That matters because the
// input is user-authored text from the user's own repository on its way into a `jsonb`
// column that an anonymous public page reads. A snapshot the column's own validator
// would reject is a FAILED PUBLISH INSERT (db-lib measured `('{"a":"x\0y"}')::jsonb` ->
// `ERROR: unsupported Unicode escape sequence` against Compose Postgres 17), and this
// capture is meant to be best-effort, never a way to break publishing.
//
// U-MOB7 alone would be satisfied by a builder that returned `null` for everything, so
// it asserts BOTH halves: adversarial inputs must not produce an invalid snapshot, and
// realistic inputs must not produce `null`. U-MOB8/U-MOB9 make that concrete —
// sanitizing and truncating are the mechanism, and degrading to `null` is the last
// resort rather than the strategy.

const NOW = new Date("2026-07-26T12:00:00.000Z");

function scene(over: Partial<ManifestScene> = {}): ManifestScene {
  return {
    id: "sc-1",
    name: "Opening",
    scriptText: "He who dwells in the shelter of the Most High",
    reference: "Psalm 91:1",
    translation: "BSB",
    visualPrompt: "a wide desert at dawn",
    durationSeconds: 4,
    captions: true,
    ...over,
  };
}

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    manifestVersion: 1,
    composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
    scenes: [scene()],
    narratorVoice: { description: "Calm, measured narrator" },
    ...over,
  };
}

/** The builder is allowed to return `null`; every test that asserts on the VALUE goes
 *  through here so a silent degradation can never be mistaken for a passing assertion. */
function build(m: ProjectManifest, now: Date = NOW) {
  const snap = buildMakingOfSnapshot(m, now);
  expect(snap, "expected a snapshot, got null").not.toBeNull();
  return snap!;
}

describe("buildMakingOfSnapshot — the scene grid", () => {
  it("U-MOB1: a 4-scene manifest maps to 4 tiles with 1-based indexes, names and durations in order", () => {
    const snap = build(
      manifest({
        scenes: [
          scene({ id: "a", name: "The Shelter", durationSeconds: 4 }),
          scene({ id: "b", name: "The Fowler's Snare", durationSeconds: 6.5 }),
          scene({ id: "c", name: "His Feathers", durationSeconds: 3 }),
          scene({ id: "d", name: "No Fear", durationSeconds: 8 }),
        ],
      }),
    );

    expect(snap.scenes).toEqual([
      { index: 1, name: "The Shelter", durationSeconds: 4 },
      { index: 2, name: "The Fowler's Snare", durationSeconds: 6.5 },
      { index: 3, name: "His Feathers", durationSeconds: 3 },
      { index: 4, name: "No Fear", durationSeconds: 8 },
    ]);
  });

  it("U-MOB6: a 200-scene manifest is TRUNCATED to the schema's 64 and the output still parses", () => {
    const scenes = Array.from({ length: 200 }, (_, i) =>
      scene({ id: `s${i}`, name: `Scene ${i + 1}`, scriptText: `line ${i + 1}` }),
    );
    const snap = build(manifest({ scenes }));

    expect(MAX_SNAPSHOT_SCENES).toBe(64);
    expect(snap.scenes).toHaveLength(64);
    // The FIRST 64, keeping their own 1-based tile numbers — not a resampled subset.
    expect(snap.scenes[0]).toEqual({
      index: 1,
      name: "Scene 1",
      durationSeconds: 4,
    });
    expect(snap.scenes[63]).toEqual({
      index: 64,
      name: "Scene 64",
      durationSeconds: 4,
    });
    expect(GalleryMakingOfSchema.safeParse(snap).success).toBe(true);
  });
});

describe("buildMakingOfSnapshot — the scripture paragraph", () => {
  it("U-MOB2: scriptureText is every scene's scriptText joined with a single space, trimmed", () => {
    const snap = build(
      manifest({
        scenes: [
          scene({ id: "a", scriptText: "  He who dwells  " }),
          scene({ id: "b", scriptText: "in the shelter" }),
          scene({ id: "c", scriptText: "of the Most High.  " }),
        ],
      }),
    );

    expect(snap.scriptureText).toBe(
      "He who dwells in the shelter of the Most High.",
    );
  });

  it("U-MOB3: a manifest whose scenes carry no scriptText yields scriptureText: null, not \"\"", () => {
    // `scriptText` is `z.string().min(1)` in the manifest schema, so a whitespace-only
    // value is schema-VALID and reaches here — as does a scenes-free scaffold.
    const whitespace = build(
      manifest({
        scenes: [scene({ id: "a", scriptText: " " }), scene({ id: "b", scriptText: "\t" })],
      }),
    );
    expect(whitespace.scriptureText).toBeNull();

    const empty = build(manifest({ scenes: [] }));
    expect(empty.scriptureText).toBeNull();
  });
});

describe("buildMakingOfSnapshot — the chips", () => {
  it("U-MOB4: captionsOn is TRUE only when every scene has captions", () => {
    const all = build(
      manifest({
        scenes: [scene({ id: "a", captions: true }), scene({ id: "b", captions: true })],
      }),
    );
    expect(all.captionsOn).toBe(true);

    // The MIXED case is the one that decides the rule; "some" would render a chip that
    // claims captions for scenes that have none.
    const mixed = build(
      manifest({
        scenes: [scene({ id: "a", captions: true }), scene({ id: "b", captions: false })],
      }),
    );
    expect(mixed.captionsOn).toBe(false);

    const none = build(
      manifest({
        scenes: [scene({ id: "a", captions: false })],
      }),
    );
    expect(none.captionsOn).toBe(false);

    // ...and NOT vacuously true for zero scenes: `[].every()` is `true`, which would
    // put a "captions on" chip under a video that has no scenes at all.
    const noScenes = build(manifest({ scenes: [] }));
    expect(noScenes.captionsOn).toBe(false);
  });

  it("U-MOB5: a missing narratorVoice / music yields null labels, not the string \"undefined\"", () => {
    const noMusic = build(manifest());
    expect(noMusic.musicStyle).toBeNull();

    // `narratorVoice` is REQUIRED by ProjectManifestSchema, so this is the defensive
    // case: a hand-rolled or future manifest reaching the builder without one.
    const noVoice = build(
      manifest({ narratorVoice: undefined as unknown as ProjectManifest["narratorVoice"] }),
    );
    expect(noVoice.narratorVoiceLabel).toBeNull();

    const withMusic = build(
      manifest({ music: { style: "Ambient strings, slow build" } }),
    );
    expect(withMusic.musicStyle).toBe("Ambient strings, slow build");
  });

  it("U-MOB11: narratorVoiceLabel prefers the voice's `label` and falls back to its `description`", () => {
    const labelled = build(
      manifest({
        narratorVoice: {
          description: "A calm, measured, unhurried narrator",
          label: "JAMES EARL JONES-STYLE",
        },
      }),
    );
    expect(labelled.narratorVoiceLabel).toBe("JAMES EARL JONES-STYLE");

    const unlabelled = build(
      manifest({ narratorVoice: { description: "Calm, measured narrator" } }),
    );
    expect(unlabelled.narratorVoiceLabel).toBe("Calm, measured narrator");
  });
});

describe("buildMakingOfSnapshot — the value gates are enforcement, not documentation", () => {
  it("U-MOB8: a NUL / control character in a scene name or scriptText is STRIPPED, not degraded to a null snapshot", () => {
    const snap = build(
      manifest({
        scenes: [
          scene({
            id: "a",
            name: "The\u0000Shelter",
            scriptText: "He who\u0007 dwells",
          }),
        ],
      }),
    );

    expect(snap.scenes[0].name).toBe("TheShelter");
    expect(snap.scriptureText).toBe("He who dwells");
    // The point of stripping rather than dropping: an unprintable byte costs a
    // character, not the whole "HOW IT WAS MADE" section.
    expect(GalleryMakingOfSchema.safeParse(snap).success).toBe(true);
  });

  it("U-MOB9: over-long text is TRUNCATED to the schema's bound rather than dropping the snapshot", () => {
    const long = "a".repeat(30_000);
    const snap = build(
      manifest({
        scenes: [scene({ id: "a", name: "n".repeat(400), scriptText: long })],
        narratorVoice: { description: "d".repeat(400) },
        music: { style: "m".repeat(400) },
      }),
    );

    expect(snap.scriptureText).toHaveLength(20_000);
    expect(snap.scenes[0].name).toHaveLength(120);
    expect(snap.narratorVoiceLabel).toHaveLength(120);
    expect(snap.musicStyle).toHaveLength(120);
    expect(GalleryMakingOfSchema.safeParse(snap).success).toBe(true);
  });

  it("U-MOB12: a truncation that would split a surrogate pair does not emit an unpaired surrogate", () => {
    // One ASCII character then 12 000 astral pairs, so the 20 000-code-unit cut lands
    // exactly BETWEEN the halves of a pair — an unpaired surrogate, which
    // `jsonbSafeText` rejects. The builder must not simply `slice`.
    const snap = build(
      manifest({
        scenes: [scene({ id: "a", scriptText: `x${"\u{1F525}".repeat(12_000)}` })],
      }),
    );
    expect(snap.scriptureText!.length).toBeLessThanOrEqual(20_000);
    expect(GalleryMakingOfSchema.safeParse(snap).success).toBe(true);
  });

  it("U-MOB13: a scene whose name sanitizes away keeps a tile with a stable fallback name", () => {
    const snap = build(
      manifest({ scenes: [scene({ id: "a", name: "\u0000\u0001" })] }),
    );
    expect(snap.scenes).toEqual([
      { index: 1, name: "Scene 1", durationSeconds: 4 },
    ]);
  });

  it("U-MOB14: a scene with a non-positive or non-finite duration is DROPPED, and the survivors keep their original tile numbers", () => {
    const snap = build(
      manifest({
        scenes: [
          scene({ id: "a", name: "One", durationSeconds: 4 }),
          scene({ id: "b", name: "Two", durationSeconds: 0 }),
          scene({
            id: "c",
            name: "Three",
            durationSeconds: Number.NaN as unknown as number,
          }),
          scene({ id: "d", name: "Four", durationSeconds: 2 }),
        ],
      }),
    );

    // 1 and 4 — a truthful GAP, because `index` is the tile NUMBER the design prints,
    // and renumbering would claim the video has two scenes in a row that it does not.
    expect(snap.scenes).toEqual([
      { index: 1, name: "One", durationSeconds: 4 },
      { index: 4, name: "Four", durationSeconds: 2 },
    ]);
  });
});

describe("buildMakingOfSnapshot — the clock and the version", () => {
  it("U-MOB10: capturedAt is the INJECTED clock's ISO instant and version is the literal 1", () => {
    const snap = build(manifest(), new Date("2020-01-02T03:04:05.678Z"));
    expect(snap.capturedAt).toBe("2020-01-02T03:04:05.678Z");
    expect(snap.version).toBe(1);
  });

  it("U-MOB15: an invalid clock yields null rather than a snapshot with an unparseable capturedAt", () => {
    expect(buildMakingOfSnapshot(manifest(), new Date(Number.NaN))).toBeNull();
  });
});

describe("buildMakingOfSnapshot — the whole-output property", () => {
  it("U-MOB7: the output of buildMakingOfSnapshot always satisfies GalleryMakingOfSchema", () => {
    // Each row states whether a snapshot is EXPECTED, so a builder that returned `null`
    // for everything — which would satisfy "never invalid" trivially — fails here.
    const table: Array<{ what: string; m: ProjectManifest; expectSnapshot: boolean }> = [
      { what: "the blank scaffold", m: manifest({ scenes: [] }), expectSnapshot: true },
      { what: "a normal 3-scene project", m: manifest({
        scenes: [scene({ id: "a" }), scene({ id: "b" }), scene({ id: "c" })],
        music: { style: "Ambient" },
      }), expectSnapshot: true },
      { what: "200 scenes", m: manifest({
        scenes: Array.from({ length: 200 }, (_, i) => scene({ id: `s${i}` })),
      }), expectSnapshot: true },
      { what: "NUL bytes everywhere", m: manifest({
        scenes: [scene({ id: "a", name: "a\u0000b", scriptText: "c\u0000d" })],
        narratorVoice: { description: "e\u0000f" },
        music: { style: "g\u0000h" },
      }), expectSnapshot: true },
      { what: "an unpaired surrogate", m: manifest({
        scenes: [scene({ id: "a", name: "x\uD800y", scriptText: "\uDC00 lone low" })],
      }), expectSnapshot: true },
      { what: "30 000 characters of scripture", m: manifest({
        scenes: [scene({ id: "a", scriptText: "z".repeat(30_000) })],
      }), expectSnapshot: true },
      { what: "every string sanitizes to nothing", m: manifest({
        scenes: [scene({ id: "a", name: "\u0000", scriptText: "\u0000" })],
        narratorVoice: { description: "\u0000" },
        music: { style: "\u0000" },
      }), expectSnapshot: true },
      { what: "tabs and newlines (EXEMPT controls, kept)", m: manifest({
        scenes: [scene({ id: "a", scriptText: "line one\nline two" })],
      }), expectSnapshot: true },
    ];

    for (const { what, m, expectSnapshot } of table) {
      const snap = buildMakingOfSnapshot(m, NOW);
      if (expectSnapshot) {
        expect(snap, `${what}: expected a snapshot, got null`).not.toBeNull();
      }
      if (snap !== null) {
        const parsed = GalleryMakingOfSchema.safeParse(snap);
        expect(
          parsed.success,
          `${what}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
        ).toBe(true);
      }
    }
  });

  it("U-MOB16: the exempt controls (tab, LF, CR) SURVIVE — a joined passage may legitimately carry a newline", () => {
    const snap = build(
      manifest({ scenes: [scene({ id: "a", scriptText: "line one\nline two" })] }),
    );
    expect(snap.scriptureText).toBe("line one\nline two");
  });
});
