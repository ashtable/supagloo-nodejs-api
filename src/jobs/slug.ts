/**
 * Project slug derivation (design-delta §2.6; wireframe 12a/13a "name defaults to repo
 * name"). The slug drives `/studio/[slug]` and is unique PER OWNER
 * (`@@unique([ownerId, slug])`).
 *
 * Duplicate-REPO dedup is keyed on `(ownerId, repoOwner, repoName)` in the service, so
 * slug suffixing here only resolves the RARE case where two DIFFERENT repos kebab-case
 * to the same slug for one owner.
 */

/** Kebab-case a repo/project name: lowercase, collapse non-alphanumerics to single
 *  dashes, trim leading/trailing dashes. Empty/symbol-only → `"project"`. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "project";
}

/** The base slug if free, else `base-2`, `base-3`, … past every taken slug. */
export function nextFreeSlug(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
