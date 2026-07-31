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

/**
 * `isConnected` — the single-provider predicate behind the new 409
 * `provider_not_connected` gate on `POST /v1/ai/generations` (R5/R7, 2026-07-31).
 *
 * ## Why the gate needs its own method rather than calling `readAll`
 *
 * `createGeneration` asks about exactly ONE provider, on the hot path of every reroll,
 * narration and video generation. `readAll` is three `findUnique`s; two of them would be
 * answering a question nobody asked.
 *
 * ## Why that is dangerous, and what holds it
 *
 * A second implementation of "is this connected?" is a second place for the rule to live,
 * and this codebase has been bitten by exactly that shape before (memory
 * `one-rule-one-module-many-boundaries`). The rule is ROW PRESENCE — the `status` column is
 * written as the literal `"connected"` and never read back — so a drift here would most
 * likely be someone "improving" one of the two into a `status` check while the other kept
 * reading presence, and the two would disagree only for rows nobody creates today.
 *
 * `U-PNC2` is the pin: it drives BOTH answers over the same fixtures and requires them to
 * agree, so the two implementations cannot diverge without a red test.
 */
describe("ConnectionsService.isConnected", () => {
  const PROVIDERS = ["github", "openrouter", "gloo"] as const;
  const ROW = { userId: "u1" };

  it("U-PNC1: is true iff that provider's row exists, for each of the three", async () => {
    for (const provider of PROVIDERS) {
      const present = makeFakePrisma({ [provider]: ROW });
      expect(
        await new ConnectionsService({ prisma: present.prisma }).isConnected(
          "u1",
          provider,
        ),
        `${provider} with a row must read connected`,
      ).toBe(true);

      const absent = makeFakePrisma({});
      expect(
        await new ConnectionsService({ prisma: absent.prisma }).isConnected(
          "u1",
          provider,
        ),
        `${provider} with no row must read NOT connected`,
      ).toBe(false);
    }
  });

  it("U-PNC1b: one provider's row never answers for another, and the read is userId-scoped", async () => {
    // The discrimination check. Without it, an implementation that ignored `provider` and
    // looked at whichever table it liked would satisfy U-PNC1 as long as the fixture only
    // ever had one row — and it would let a user with ONLY OpenRouter enqueue Gloo work,
    // which is the precise hole this gate exists to close.
    const { prisma, calls } = makeFakePrisma({ openrouter: ROW });
    const service = new ConnectionsService({ prisma });

    expect(await service.isConnected("u1", "openrouter")).toBe(true);
    expect(await service.isConnected("u1", "gloo")).toBe(false);
    expect(await service.isConnected("u1", "github")).toBe(false);

    for (const c of calls) expect(c.where).toEqual({ userId: "u1" });
  });

  it("U-PNC2: agrees with readAll for every provider × present/absent — the anti-drift pin", async () => {
    const disagreements: string[] = [];
    for (const provider of PROVIDERS) {
      for (const present of [true, false]) {
        const rows = present ? { [provider]: ROW } : {};
        const viaReadAll =
          (await new ConnectionsService({
            prisma: makeFakePrisma(rows).prisma,
          }).readAll("u1"))[provider] !== null;
        const viaPredicate = await new ConnectionsService({
          prisma: makeFakePrisma(rows).prisma,
        }).isConnected("u1", provider);

        if (viaReadAll !== viaPredicate) {
          disagreements.push(
            `${provider} (row ${present ? "present" : "absent"}): readAll=${viaReadAll} isConnected=${viaPredicate}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
