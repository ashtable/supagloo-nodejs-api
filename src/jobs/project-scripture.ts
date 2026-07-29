import { z } from "zod";
import type { ProjectManifest } from "@supagloo/database-lib";

/**
 * Feature 2 — the passage the New-project wizard's step 2 collected, declared LOCALLY.
 *
 * ## Why this file exists at all
 *
 * `POST /v1/projects` validates its body with db-lib's `CreateProjectRequestSchema`, and
 * this repo resolves `@supagloo/database-lib` through the nested submodule, which only
 * moves at the release step. Until that gitlink moves, db-lib's copy here has no
 * `scripture` field — and a plain `z.object` **strips unknown keys silently**. The wizard
 * would post the passage, get its 201, watch the project scaffold, and the selection would
 * simply be gone. No error, no partial write, nothing to look at.
 *
 * Declaring the shape here closes that window: the route extends the request schema with
 * it, so the field is VALIDATED (a malformed block is a loud 400, not a quiet drop) and
 * reaches the service today.
 *
 * **DELETE THIS FILE AT THE db-lib BUMP** and read `CreateProjectRequestSchema.scripture`
 * / `ManifestScriptureSchema` directly. This is byte-identical to db-lib's
 * `ManifestScriptureSchema`, and `project-scripture.test.ts` holds the two against each
 * other BEHAVIOURALLY — same accepts, same rejects, same parsed output. That check reads
 * the db-lib barrel at RUNTIME, so it is inert (and asserts that it is inert, rather than
 * skipping) while the pinned SHA predates the export, and starts comparing for real the
 * moment the submodule bump lands. Nothing has to be remembered at the release.
 *
 * ## What it deliberately does not carry
 *
 * The passage TEXT. The manifest is committed into the user's (possibly public) GitHub
 * repo, verse text is third-party licensed content, and `passageId` re-fetches it.
 * `passageId` is the YouVersion USFM exactly as the chapters route handed it out — echoed,
 * never constructed.
 */
export const ProjectScriptureSchema = z.object({
  reference: z.string().min(1),
  // Deliberately a free non-empty string, not an enum: §9-Q10 / task #58 — the licensed
  // translation set is a property of the language and is validated against the live
  // YouVersion collection at generation time, never enum-gated at a wire boundary.
  translation: z.string().min(1),
  language: z.string().min(1).optional(),
  passageId: z.string().min(1).optional(),
});
export type ProjectScripture = z.infer<typeof ProjectScriptureSchema>;

/**
 * The scaffolded manifest, with the wizard's passage seeded at the PROJECT level.
 *
 * Project-level, not a synthesized first scene. `ManifestSceneSchema` requires
 * `scriptText`, `visualPrompt`, `name` and `durationSeconds` alongside
 * `reference`/`translation`, so seeding a scene would mean inventing generated content the
 * user never asked for, committing it to their repo, and having the first storyboard
 * generation replace it wholesale. The origin passage is project-shaped in fact: it
 * survives a re-plan; a scene does not.
 *
 * Absent scripture ⇒ the returned manifest is BYTE-IDENTICAL to `buildBlankManifest()`.
 * The cast is the same forward declaration as above.
 */
export function seedManifestScripture(
  manifest: ProjectManifest,
  scripture: ProjectScripture | undefined,
): ProjectManifest {
  if (!scripture) return manifest;
  return { ...manifest, scripture } as ProjectManifest;
}
