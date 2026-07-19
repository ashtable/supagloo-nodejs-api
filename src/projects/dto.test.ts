import { describe, it, expect } from "vitest";
import {
  ProjectDtoSchema,
  ProjectVersionDtoSchema,
  type Project,
  type ProjectVersion,
} from "@supagloo/database-lib";
import { toProjectDto, toProjectVersionDto } from "./dto";

// Unit tests for the Project/ProjectVersion row→wire mappers (Task #14). Pure — no
// DB. They assert: Date columns become ISO-8601 strings, `ownerId`/`deletedAt` are
// dropped (the caller is the owner; deleted rows are filtered out upstream), and the
// output parses its wire schema.

const PROJECT_ROW: Project = {
  id: "p1",
  slug: "psalm-121",
  ownerId: "u1",
  name: "Psalm 121",
  repoOwner: "ashtable",
  repoName: "psalm-121",
  repoVisibility: "private",
  createdFrom: "blank",
  currentBranch: "v0.0.1",
  thumbnailAssetKey: null,
  lastRenderJobId: null,
  lastOpenedAt: new Date("2026-07-19T00:00:00.000Z"),
  createdAt: new Date("2026-07-18T00:00:00.000Z"),
  deletedAt: null,
};

const VERSION_ROW: ProjectVersion = {
  id: "v1",
  projectId: "p1",
  semver: "0.0.1",
  branchName: "v0.0.1",
  state: "working",
  commitMessage: null,
  autoSummary: null,
  changedFiles: [],
  headCommitSha: null,
  prNumber: null,
  prUrl: null,
  publishedAt: null,
};

describe("toProjectDto", () => {
  it("maps a row to the wire DTO, ISO-stringing dates and omitting ownerId/deletedAt", () => {
    const dto = toProjectDto(PROJECT_ROW);

    expect(dto).toEqual({
      id: "p1",
      slug: "psalm-121",
      name: "Psalm 121",
      repoOwner: "ashtable",
      repoName: "psalm-121",
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
      thumbnailAssetKey: null,
      lastRenderJobId: null,
      lastOpenedAt: "2026-07-19T00:00:00.000Z",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    expect("ownerId" in dto).toBe(false);
    expect("deletedAt" in dto).toBe(false);
    expect(ProjectDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("passes populated nullable asset keys through", () => {
    const dto = toProjectDto({
      ...PROJECT_ROW,
      thumbnailAssetKey: "renders/rj1/thumb.jpg",
      lastRenderJobId: "rj1",
    });
    expect(dto.thumbnailAssetKey).toBe("renders/rj1/thumb.jpg");
    expect(dto.lastRenderJobId).toBe("rj1");
  });
});

describe("toProjectVersionDto", () => {
  it("maps a row to the wire DTO with null nullable fields and passes changedFiles through", () => {
    const dto = toProjectVersionDto(VERSION_ROW);
    expect(dto).toEqual({
      id: "v1",
      projectId: "p1",
      semver: "0.0.1",
      branchName: "v0.0.1",
      state: "working",
      commitMessage: null,
      autoSummary: null,
      changedFiles: [],
      headCommitSha: null,
      prNumber: null,
      prUrl: null,
      publishedAt: null,
    });
    expect(ProjectVersionDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("ISO-strings publishedAt and carries the changedFiles list + PR fields", () => {
    const dto = toProjectVersionDto({
      ...VERSION_ROW,
      state: "published",
      commitMessage: "ship it",
      changedFiles: ["M src/scenes/Shelter.tsx"],
      headCommitSha: "abc123",
      prNumber: 7,
      prUrl: "https://github.com/x/y/pull/7",
      publishedAt: new Date("2026-07-19T00:00:00.000Z"),
    });
    expect(dto.publishedAt).toBe("2026-07-19T00:00:00.000Z");
    expect(dto.changedFiles).toEqual(["M src/scenes/Shelter.tsx"]);
    expect(dto.prNumber).toBe(7);
    expect(ProjectVersionDtoSchema.safeParse(dto).success).toBe(true);
  });
});
