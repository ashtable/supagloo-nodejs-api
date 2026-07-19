import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import { ProjectsService } from "./projects-service";
import { ProjectNotFoundError } from "./errors";

// Unit tests for ProjectsService (Task #14, design-delta §2.6/§8). A FAKE Prisma
// records the exact queries so we can assert: owner scoping + soft-delete filter on
// reads, rename touches ONLY `name` (slug is a stable URL identity — never
// regenerated), soft delete sets `deletedAt` (row is NOT hard-deleted), a
// missing/foreign/soft-deleted project surfaces uniformly as ProjectNotFoundError,
// and versions come back ordered by REAL semver descending (0.10.0 before 0.2.0),
// with an `id`-desc tiebreak for unparseable/equal semvers.

type Call = { op: string; args: any };

function makeFakePrisma(config: {
  projects?: unknown[];
  project?: unknown; // findFirst result
  versions?: unknown[];
}) {
  const calls: Call[] = [];
  const record = (op: string, result: unknown) => (args: any) => {
    calls.push({ op, args });
    return Promise.resolve(result);
  };
  const prisma = {
    project: {
      findMany: record("project.findMany", config.projects ?? []),
      findFirst: record("project.findFirst", config.project ?? null),
      update: (args: any) => {
        calls.push({ op: "project.update", args });
        return Promise.resolve({ ...(config.project as object), ...args.data });
      },
      delete: record("project.delete", {}),
    },
    projectVersion: {
      findMany: record("projectVersion.findMany", config.versions ?? []),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

const has = (calls: Call[], op: string) => calls.some((c) => c.op === op);
const find = (calls: Call[], op: string) => calls.find((c) => c.op === op)!;

describe("ProjectsService.listProjects", () => {
  it("returns the owner's non-deleted projects, most-recently-opened first", async () => {
    const rows = [{ id: "p1" }, { id: "p2" }];
    const { prisma, calls } = makeFakePrisma({ projects: rows });

    const res = await new ProjectsService({ prisma }).listProjects("u1");

    expect(res).toEqual(rows);
    const call = find(calls, "project.findMany");
    expect(call.args.where).toEqual({ ownerId: "u1", deletedAt: null });
    expect(call.args.orderBy).toEqual({ lastOpenedAt: "desc" });
  });
});

describe("ProjectsService.getProject", () => {
  it("resolves a project scoped to owner + not-deleted", async () => {
    const { prisma, calls } = makeFakePrisma({
      project: { id: "p1", ownerId: "u1" },
    });

    const res = await new ProjectsService({ prisma }).getProject("u1", "p1");

    expect(res).toEqual({ id: "p1", ownerId: "u1" });
    expect(find(calls, "project.findFirst").args.where).toEqual({
      id: "p1",
      ownerId: "u1",
      deletedAt: null,
    });
  });

  it("throws ProjectNotFoundError when no matching row (missing/foreign/deleted)", async () => {
    const { prisma } = makeFakePrisma({ project: null });
    await expect(
      new ProjectsService({ prisma }).getProject("u1", "ghost"),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe("ProjectsService.renameProject", () => {
  it("updates ONLY name (slug is never regenerated)", async () => {
    const { prisma, calls } = makeFakePrisma({
      project: { id: "p1", ownerId: "u1", name: "Old", slug: "old-slug" },
    });

    const res = await new ProjectsService({ prisma }).renameProject(
      "u1",
      "p1",
      "New Name",
    );

    const upd = find(calls, "project.update");
    expect(upd.args.where).toEqual({ id: "p1" });
    expect(upd.args.data).toEqual({ name: "New Name" });
    expect(Object.keys(upd.args.data)).toEqual(["name"]); // no slug
    expect(res.name).toBe("New Name");
    expect(res.slug).toBe("old-slug"); // untouched
  });

  it("throws ProjectNotFoundError and issues no update for an invisible project", async () => {
    const { prisma, calls } = makeFakePrisma({ project: null });
    await expect(
      new ProjectsService({ prisma }).renameProject("u1", "ghost", "X"),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(has(calls, "project.update")).toBe(false);
  });
});

describe("ProjectsService.deleteProject", () => {
  it("soft-deletes by setting deletedAt from the injected clock (row not hard-deleted)", async () => {
    const now = () => new Date("2026-07-19T12:00:00.000Z");
    const { prisma, calls } = makeFakePrisma({
      project: { id: "p1", ownerId: "u1" },
    });

    await new ProjectsService({ prisma, now }).deleteProject("u1", "p1");

    const upd = find(calls, "project.update");
    expect(upd.args.where).toEqual({ id: "p1" });
    expect(upd.args.data).toEqual({
      deletedAt: new Date("2026-07-19T12:00:00.000Z"),
    });
    expect(has(calls, "project.delete")).toBe(false); // soft, not hard
  });

  it("throws ProjectNotFoundError and issues no update on an already-invisible project", async () => {
    const { prisma, calls } = makeFakePrisma({ project: null });
    await expect(
      new ProjectsService({ prisma }).deleteProject("u1", "gone"),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(has(calls, "project.update")).toBe(false);
  });
});

describe("ProjectsService.listVersions", () => {
  it("resolves the owner-scoped project, then returns versions descending by real semver", async () => {
    const versions = [
      { id: "v-a", semver: "0.2.0" },
      { id: "v-b", semver: "0.10.0" },
      { id: "v-c", semver: "0.0.1" },
    ];
    const { prisma, calls } = makeFakePrisma({
      project: { id: "p1", ownerId: "u1" },
      versions,
    });

    const res = await new ProjectsService({ prisma }).listVersions("u1", "p1");

    // Numeric semver order, NOT lexical ("0.10.0" would sort before "0.2.0"
    // lexically — that would be wrong).
    expect(res.map((v: any) => v.semver)).toEqual(["0.10.0", "0.2.0", "0.0.1"]);
    expect(find(calls, "project.findFirst").args.where).toEqual({
      id: "p1",
      ownerId: "u1",
      deletedAt: null,
    });
    expect(find(calls, "projectVersion.findMany").args.where).toEqual({
      projectId: "p1",
    });
  });

  it("sorts parseable semvers above unparseable, and breaks ties/unparseables by id desc", async () => {
    const versions = [
      { id: "v-1", semver: "bad" },
      { id: "v-3", semver: "bad" },
      { id: "v-2", semver: "0.0.1" },
    ];
    const { prisma } = makeFakePrisma({
      project: { id: "p1", ownerId: "u1" },
      versions,
    });

    const res = await new ProjectsService({ prisma }).listVersions("u1", "p1");

    // Parseable first; the two unparseables fall to the deterministic id-desc tiebreak.
    expect(res.map((v: any) => v.id)).toEqual(["v-2", "v-3", "v-1"]);
  });

  it("throws ProjectNotFoundError (and never queries versions) for a foreign/missing project", async () => {
    const { prisma, calls } = makeFakePrisma({ project: null });
    await expect(
      new ProjectsService({ prisma }).listVersions("u1", "p1"),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(has(calls, "projectVersion.findMany")).toBe(false);
  });
});
