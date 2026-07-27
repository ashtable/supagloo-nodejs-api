import {
  GalleryMakingOfSchema,
  type GalleryMakingOf,
  type GalleryMakingOfScene,
  type ManifestScene,
  type ProjectManifest,
} from "@supagloo/database-lib";
import { POSTGRES_TEXT_EXEMPT_CONTROL_CODES } from "../postgres-text";

/**
 * The PURE manifest → `GalleryItem.makingOf` snapshot builder (Turn 16a, plan slice C3).
 *
 * No I/O, no clock of its own, no DB: it takes the project's already-validated
 * `supagloo.project.json` and the capture instant, and returns the value the publish path
 * writes into the row's `jsonb` column — or `null` when it cannot honestly produce one.
 *
 * WHY THE OUTPUT IS RE-VALIDATED against the very schema that types it. The input is a
 * `ProjectManifest`, which guarantees *shape* and almost nothing about *content*: every
 * one of its display strings is `z.string().min(1)`, so a scene name may be a single NUL
 * byte, a `scriptText` may be a megabyte, and either may carry an unpaired surrogate.
 * `GalleryMakingOfSchema` refuses all three (db-lib measured an ungated NUL as
 * `ERROR: unsupported Unicode escape sequence` on a real `::jsonb` cast), and this value
 * is on its way into an INSERT that must not fail. So the builder does three things in
 * order, and the order is the design:
 *
 *   1. **SANITIZE** — strip the forbidden C0/DEL controls (keeping tab, LF and CR, which
 *      a joined passage legitimately carries) and unpaired surrogates;
 *   2. **TRUNCATE** — 64 scenes, 120-character labels, 20 000 characters of scripture,
 *      re-stripping any surrogate the cut split in half;
 *   3. **VALIDATE** — `safeParse`, and return `null` if anything still does not fit.
 *
 * Step 3 is the backstop, not the strategy. A builder that simply returned `null` for
 * every awkward input would satisfy "never writes an invalid snapshot" while quietly
 * deleting the whole section for anyone whose manifest contains a stray character, which
 * is why steps 1 and 2 exist and are separately tested (U-MOB8/U-MOB9/U-MOB12).
 */

/** The schema's `scenes` cap. Exported so the test asserts the SAME number the column's
 *  validator enforces rather than a copy of it. */
export const MAX_SNAPSHOT_SCENES = 64;

/** `GalleryMakingOfSchema`'s label bound — narrator voice, music style, scene name. */
const MAX_LABEL_CHARS = 120;

/** `GalleryMakingOfSchema`'s `scriptureText` bound. */
const MAX_SCRIPTURE_CHARS = 20_000;

/**
 * C0 (U+0000–U+001F) + DEL (U+007F) LESS the exempt codes, as a GLOBAL matcher.
 *
 * The class is deliberately identical to db-lib's `jsonbSafeText` and to this api's
 * `src/postgres-text.ts` — one rule, three boundaries. The difference here is the verb:
 * those two REFUSE, this one REMOVES, because refusing at capture time would cost a
 * publish its whole "HOW IT WAS MADE" section over one unprintable byte.
 *
 * The EXEMPT SET is IMPORTED, not re-typed. This module and `postgres-text.ts` ship in
 * the same package, so a second hand-maintained copy of the list buys nothing — and that
 * module's own header records what one copy already cost: its JSDoc said `\t \n \r` while
 * the effective behaviour exempted five characters, and `?q=%0B` came back as a
 * match-everything listing. One list, two verbs. (db-lib keeps a third copy only because
 * it cannot import from a consumer; that one is fenced by both suites enumerating the
 * class.)
 */
const FORBIDDEN_CONTROL_CHARS = new RegExp(
  `[${[...Array.from({ length: 32 }, (_, i) => i), 0x7f]
    .filter((code) => !POSTGRES_TEXT_EXEMPT_CONTROL_CODES.includes(code))
    .map((code) => `\\u${code.toString(16).padStart(4, "0")}`)
    .join("")}]`,
  "g",
);

/** A UTF-16 surrogate code unit with no partner. `JSON.parse` produces these happily from
 *  `"\ud800"`, which is exactly how one reaches a manifest field. */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Sanitize + trim. Returns `""` for anything that is not a usable string, so every
 *  caller has ONE emptiness test rather than a null/undefined/blank ladder. */
function sanitize(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(FORBIDDEN_CONTROL_CHARS, "")
    .replace(UNPAIRED_SURROGATE, "")
    .trim();
}

/**
 * Sanitize, then cut to `max` CODE UNITS.
 *
 * The second surrogate sweep is not belt-and-braces: `slice` counts UTF-16 code units, so
 * a cut landing between the halves of an astral character leaves a lone high surrogate —
 * a string the column's validator rejects, produced by the very step meant to make the
 * value fit.
 */
function clamp(raw: unknown, max: number): string {
  const clean = sanitize(raw);
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(UNPAIRED_SURROGATE, "").trim();
}

/** `""` → `null`. "We do not have a music style" and "the music style is empty" must not
 *  be the same wire value: one renders no chip, the other renders an empty one. */
function nullIfBlank(value: string): string | null {
  return value.length === 0 ? null : value;
}

/**
 * One tile, or `null` when the scene cannot honestly be one.
 *
 * `index` is the scene's ORIGINAL 1-based position and is the number the design PRINTS on
 * the tile, so an unusable scene leaves a GAP (1, 2, 4) rather than renumbering its
 * successors — renumbering would claim the video has consecutive scenes it does not have.
 * That is the same rule the listing's `rank` follows when a row vanishes mid-page.
 */
function toTile(scene: ManifestScene, index: number): GalleryMakingOfScene | null {
  const duration = scene?.durationSeconds;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  // A name that sanitizes away still gets a tile: the SCENE is real, only its label was
  // unusable, and dropping the tile would misstate the scene count.
  const name = clamp(scene?.name, MAX_LABEL_CHARS) || `Scene ${index}`;
  return { index, name, durationSeconds: duration };
}

/**
 * Build the publish-time snapshot, or `null`.
 *
 * @param manifest the project's validated `supagloo.project.json`
 * @param now the capture instant (injected — `capturedAt` is assertable, not "recent")
 */
export function buildMakingOfSnapshot(
  manifest: ProjectManifest,
  now: Date,
): GalleryMakingOf | null {
  // An unusable clock is the one input that cannot be sanitized into something truthful:
  // `new Date(NaN).toISOString()` THROWS, and a publish must never fail for this.
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;

  const allScenes: ManifestScene[] = Array.isArray(manifest?.scenes)
    ? manifest.scenes
    : [];

  const scenes = allScenes
    .slice(0, MAX_SNAPSHOT_SCENES)
    .map((scene, i) => toTile(scene, i + 1))
    .filter((tile): tile is GalleryMakingOfScene => tile !== null);

  // The SCRIPTURE section is the passage the video renders, so it is joined from EVERY
  // scene — not only the 64 the grid draws. A viewer reading the passage under a
  // 70-scene video should get the passage, not the first 64 scenes' worth of it.
  const scriptureText = clamp(
    allScenes
      .map((scene) => sanitize(scene?.scriptText))
      .filter((text) => text.length > 0)
      .join(" "),
    MAX_SCRIPTURE_CHARS,
  );

  // Prefer the punchy `label` the design draws on the chip; fall back to the required
  // `description`, truncated — a chip, not a paragraph.
  const voice = manifest?.narratorVoice;
  const narratorVoiceLabel =
    clamp(voice?.label, MAX_LABEL_CHARS) || clamp(voice?.description, MAX_LABEL_CHARS);

  const candidate = {
    version: 1 as const,
    capturedAt: now.toISOString(),
    scriptureText: nullIfBlank(scriptureText),
    narratorVoiceLabel: nullIfBlank(narratorVoiceLabel),
    musicStyle: nullIfBlank(clamp(manifest?.music?.style, MAX_LABEL_CHARS)),
    // TRUE only when EVERY scene has captions, and never vacuously for a scene-free
    // project: `[].every()` is `true`, which would put a "captions on" chip under a
    // video that has no scenes at all.
    captionsOn: allScenes.length > 0 && allScenes.every((s) => s?.captions === true),
    scenes,
  };

  const parsed = GalleryMakingOfSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
