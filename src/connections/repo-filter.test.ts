import { describe, it, expect } from "vitest";
import { filterRepos } from "./repo-filter";
import type { GithubRepo } from "@supagloo/database-lib";

// Pure repo-list filter logic (design-delta §8: filter=empty|all & q= free text).
// GitHub's /installation/repositories has no server-side search, so the API
// applies both in-process — this is that logic, unit-tested in isolation.

const REPOS: GithubRepo[] = [
  { id: 1, name: "empty-one", fullName: "acme/empty-one", owner: "acme", private: true, defaultBranch: "main", empty: true },
  { id: 2, name: "empty-two", fullName: "acme/empty-two", owner: "acme", private: false, defaultBranch: "main", empty: true },
  { id: 3, name: "psalms-video", fullName: "acme/psalms-video", owner: "acme", private: true, defaultBranch: "main", empty: false },
  { id: 4, name: "genesis-app", fullName: "beta/genesis-app", owner: "beta", private: false, defaultBranch: "main", empty: false },
];

const ids = (rs: GithubRepo[]) => rs.map((r) => r.id).sort((a, b) => a - b);

describe("filterRepos", () => {
  it("filter=all returns everything", () => {
    expect(ids(filterRepos(REPOS, { filter: "all" }))).toEqual([1, 2, 3, 4]);
  });

  it("filter=empty returns only empty repos", () => {
    expect(ids(filterRepos(REPOS, { filter: "empty" }))).toEqual([1, 2]);
  });

  it("q is a case-insensitive substring over name and fullName", () => {
    expect(ids(filterRepos(REPOS, { filter: "all", q: "PSALM" }))).toEqual([3]);
    expect(ids(filterRepos(REPOS, { filter: "all", q: "beta/" }))).toEqual([4]);
    expect(ids(filterRepos(REPOS, { filter: "all", q: "empty" }))).toEqual([1, 2]);
  });

  it("filter and q compose", () => {
    expect(ids(filterRepos(REPOS, { filter: "empty", q: "two" }))).toEqual([2]);
    expect(filterRepos(REPOS, { filter: "empty", q: "psalms" })).toEqual([]);
  });

  it("blank/absent q is a no-op", () => {
    expect(ids(filterRepos(REPOS, { filter: "all", q: "" }))).toEqual([1, 2, 3, 4]);
    expect(ids(filterRepos(REPOS, { filter: "all", q: "   " }))).toEqual([1, 2, 3, 4]);
    expect(ids(filterRepos(REPOS, { filter: "all" }))).toEqual([1, 2, 3, 4]);
  });
});
