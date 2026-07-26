import type { GithubRepo, GithubRepoFilter } from "@supagloo/database-lib";

/**
 * Apply the `filter=empty|all` + `q=` free-text narrowing to a list of repos
 * (design-delta §8). GitHub's `GET /installation/repositories` has no server-side
 * search or empty filter, so the API does it in-process — this is that pure
 * logic, kept separate so it is unit-testable in isolation.
 *
 * - `filter: "all"` keeps everything; `"empty"` keeps only repos with `empty === true`.
 *   This function does NOT derive `empty` — it only reads the flag. The derivation is
 *   `github-app-client.ts`'s, in two stages (plan row 65): GitHub's `size` is KB-rounded
 *   and computed asynchronously, so it lags UPWARD and never overstates ⇒ `size > 0`
 *   short-circuits to NOT empty with no further request, and only the `size === 0`
 *   candidates are probed with `GET /repos/:owner/:repo/commits?per_page=2` — a
 *   `409 "Git Repository is empty."`, or a `200` with ≤1 commit, means empty; ≥2 commits
 *   means not empty. The ≤1 rule is deliberate: a repo created with `auto_init` holds
 *   exactly one README commit and is still an empty project. (The pre-row-65 rule was a
 *   bare `size === 0`; that derivation is retired.)
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
