import { describe, it, expect } from "vitest";
import { slugify, nextFreeSlug } from "./slug";

// Project.slug derivation (design-delta §2.6, wireframe 12a/13a "name defaults to
// repo name"). Slug drives /studio/[slug] and is unique per owner
// (@@unique([ownerId, slug])). Duplicate-REPO dedup is keyed on (owner, repoOwner,
// repoName) elsewhere; slug suffixing only handles the rare cross-repo collision.

describe("slugify", () => {
  it("lowercases and kebab-cases, collapsing non-alphanumerics", () => {
    expect(slugify("Psalm 121")).toBe("psalm-121");
    expect(slugify("My_Cool.Repo")).toBe("my-cool-repo");
    expect(slugify("UPPER")).toBe("upper");
  });

  it("trims + collapses leading/trailing/duplicate dashes", () => {
    expect(slugify("--Trim  Me--")).toBe("trim-me");
  });

  it("falls back to 'project' for an empty or symbol-only name", () => {
    expect(slugify("!!!")).toBe("project");
    expect(slugify("")).toBe("project");
  });
});

describe("nextFreeSlug", () => {
  it("returns the base slug when it is free", () => {
    expect(nextFreeSlug(new Set<string>(), "psalm-121")).toBe("psalm-121");
  });

  it("suffixes -2, -3 ... past taken slugs", () => {
    expect(nextFreeSlug(new Set(["psalm-121"]), "psalm-121")).toBe("psalm-121-2");
    expect(nextFreeSlug(new Set(["psalm-121", "psalm-121-2"]), "psalm-121")).toBe(
      "psalm-121-3",
    );
  });
});
