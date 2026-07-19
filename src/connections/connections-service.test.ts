import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import { ConnectionsService } from "./connections-service";

// ConnectionsService merge logic (design-delta §2.5 footnote / §8): the merged
// GET /v1/connections reads all THREE typed connection tables by userId and returns
// one object keyed by provider (row or null). No real DB — a fake Prisma records
// which tables were queried and returns per-table fixtures.

function makeFakePrisma(rows: {
  github?: unknown;
  openrouter?: unknown;
  gloo?: unknown;
}) {
  const calls: { table: string; where: unknown }[] = [];
  const table = (name: string, value: unknown) => ({
    findUnique: (a: { where: unknown }) => {
      calls.push({ table: name, where: a.where });
      return Promise.resolve(value ?? null);
    },
  });
  const prisma = {
    githubConnection: table("github", rows.github),
    openRouterConnection: table("openrouter", rows.openrouter),
    glooConnection: table("gloo", rows.gloo),
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

describe("ConnectionsService.readAll", () => {
  it("returns all-null when the user has connected nothing, querying each table by userId", async () => {
    const { prisma, calls } = makeFakePrisma({});
    const result = await new ConnectionsService({ prisma }).readAll("u1");

    expect(result).toEqual({ github: null, openrouter: null, gloo: null });
    // Each of the three tables was queried by the same userId.
    expect(calls.map((c) => c.table).sort()).toEqual([
      "github",
      "gloo",
      "openrouter",
    ]);
    for (const c of calls) expect(c.where).toEqual({ userId: "u1" });
  });

  it("merges a mixed set — connected openrouter + gloo, no github", async () => {
    const openrouter = { userId: "u1", keyLast4: "wxyz", status: "connected" };
    const gloo = { userId: "u1", clientId: "cid", status: "connected" };
    const { prisma } = makeFakePrisma({ openrouter, gloo });

    const result = await new ConnectionsService({ prisma }).readAll("u1");

    expect(result.github).toBeNull();
    expect(result.openrouter).toBe(openrouter);
    expect(result.gloo).toBe(gloo);
  });

  it("returns the github row alongside null openrouter/gloo", async () => {
    const github = { userId: "u1", githubLogin: "acme", installationId: "42" };
    const { prisma } = makeFakePrisma({ github });

    const result = await new ConnectionsService({ prisma }).readAll("u1");

    expect(result.github).toBe(github);
    expect(result.openrouter).toBeNull();
    expect(result.gloo).toBeNull();
  });
});
