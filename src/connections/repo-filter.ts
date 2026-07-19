import type { GithubRepo, GithubRepoFilter } from "@supagloo/database-lib";

/**
 * Apply the `filter=empty|all` + `q=` free-text narrowing to a list of repos
 * (design-delta §8). GitHub's `GET /installation/repositories` has no server-side
 * search or empty filter, so the API does it in-process — this is that pure
 * logic, kept separate so it is unit-testable in isolation.
 *
 * - `filter: "all"` keeps everything; `"empty"` keeps only repos with no content
 *   (`empty === true`, derived by the client from GitHub's `size === 0`).
 * - `q` is a case-insensitive substring match over `name` and `fullName`; a
 *   blank/whitespace/absent `q` is a no-op.
 */
export function filterRepos(
  repos: GithubRepo[],
  opts: { filter: GithubRepoFilter; q?: string },
): GithubRepo[] {
  const needle = opts.q?.trim().toLowerCase() ?? "";
  return repos.filter((r) => {
    if (opts.filter === "empty" && !r.empty) return false;
    if (needle) {
      const hay = `${r.name}\n${r.fullName}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
