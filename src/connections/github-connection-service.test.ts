import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import { GithubConnectionService } from "./github-connection-service";
import { InstallationVerificationError, GithubNotConnectedError } from "./errors";

// GithubConnectionService branch logic (design-delta §2.3/§6a). No real DB or
// network — a hand-rolled fake Prisma + fake app client + fixed clock drive every
// branch (mirrors auth-service.test.ts). The real DB + real stub are exercised
// end-to-end in tests/e2e/github-connection.e2e.ts.

const NOW = new Date("2026-07-18T12:00:00.000Z");
const clock = () => NOW;

type Fn = (args: any) => any;
interface FakeOverrides {
  findUnique?: Fn;
  upsert?: Fn;
  deleteMany?: Fn;
}

function makeFakePrisma(overrides: FakeOverrides = {}) {
  const calls = {
    findUnique: [] as any[],
    upsert: [] as any[],
    deleteMany: [] as any[],
  };
  const run = (key: keyof FakeOverrides, args: any, fallback: any) => {
    (calls as any)[key].push(args);
    const fn = overrides[key];
    return Promise.resolve(fn ? fn(args) : fallback);
  };
  const prisma = {
    githubConnection: {
      findUnique: (a: any) => run("findUnique", a, null),
      upsert: (a: any) => run("upsert", a, { userId: "u1", ...a.create }),
      deleteMany: (a: any) => run("deleteMany", a, { count: 1 }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

interface ClientOverrides {
  verifyInstallation?: Fn;
  listInstallationRepos?: Fn;
}
function makeFakeClient(overrides: ClientOverrides = {}) {
  const calls = {
    verifyInstallation: [] as any[],
    listInstallationRepos: [] as any[],
  };
  return {
    calls,
    client: {
      verifyInstallation: async (id: string) => {
        calls.verifyInstallation.push(id);
        return overrides.verifyInstallation
          ? overrides.verifyInstallation(id)
          : { githubLogin: "acme", repositorySelection: "selected" };
      },
      listInstallationRepos: async (args: { installationId: string }) => {
        calls.listInstallationRepos.push(args);
        return overrides.listInstallationRepos
          ? overrides.listInstallationRepos(args)
          : [];
      },
    },
  };
}

function service(
  prisma: PrismaClient,
  client: ReturnType<typeof makeFakeClient>["client"],
) {
  return new GithubConnectionService({
    prisma,
    verifyInstallation: client.verifyInstallation,
    listInstallationRepos: client.listInstallationRepos,
    oauthBaseUrl: "https://github.com",
    appSlug: "supagloo-app",
    clock,
  });
}

describe("GithubConnectionService.installUrl", () => {
  it("builds the hosted install-picker URL from oauth base + slug", () => {
    const { prisma } = makeFakePrisma();
    const { client } = makeFakeClient();
    expect(service(prisma, client).installUrl()).toBe(
      "https://github.com/apps/supagloo-app/installations/new",
    );
  });
});

describe("GithubConnectionService.connectFromCallback", () => {
  it("verifies then stores ONLY the 6 connection columns (no token field)", async () => {
    const { prisma, calls } = makeFakePrisma();
    const { client, calls: clientCalls } = makeFakeClient();

    const conn = await service(prisma, client).connectFromCallback("u1", "42");

    expect(clientCalls.verifyInstallation).toEqual(["42"]);
    expect(calls.upsert).toHaveLength(1);

    const upsert = calls.upsert[0];
    expect(upsert.where).toEqual({ userId: "u1" });
    // The persisted create payload is EXACTLY these keys — no token/ciphertext.
    expect(new Set(Object.keys(upsert.create))).toEqual(
      new Set([
        "userId",
        "githubLogin",
        "installationId",
        "repositorySelection",
        "status",
        "connectedAt",
      ]),
    );
    expect(upsert.create.installationId).toBe("42");
    expect(upsert.create.githubLogin).toBe("acme");
    expect(upsert.create.repositorySelection).toBe("selected");
    expect(upsert.create.status).toBe("connected");
    expect(upsert.create.connectedAt).toEqual(NOW);
    // No token-bearing key anywhere in the write.
    const allKeys = [
      ...Object.keys(upsert.create),
      ...Object.keys(upsert.update ?? {}),
    ].join(",");
    expect(allKeys).not.toMatch(/token|ciphertext|secret/i);

    expect(conn.installationId).toBe("42");
  });

  it("throws InstallationVerificationError (400) and does NOT persist when verify fails", async () => {
    const { prisma, calls } = makeFakePrisma();
    const { client } = makeFakeClient({ verifyInstallation: () => null });

    await expect(
      service(prisma, client).connectFromCallback("u1", "999"),
    ).rejects.toBeInstanceOf(InstallationVerificationError);
    expect(calls.upsert).toHaveLength(0);
  });
});

describe("GithubConnectionService.disconnect", () => {
  it("deleteMany by userId (idempotent — a 0-count delete does not throw)", async () => {
    const { prisma, calls } = makeFakePrisma({ deleteMany: () => ({ count: 0 }) });
    const { client } = makeFakeClient();
    await service(prisma, client).disconnect("u1");
    expect(calls.deleteMany).toEqual([{ where: { userId: "u1" } }]);
  });
});

describe("GithubConnectionService.listRepos", () => {
  it("throws GithubNotConnectedError (409) when there is no connection; client not called", async () => {
    const { prisma } = makeFakePrisma({ findUnique: () => null });
    const { client, calls } = makeFakeClient();
    await expect(
      service(prisma, client).listRepos("u1", { filter: "all" }),
    ).rejects.toBeInstanceOf(GithubNotConnectedError);
    expect(calls.listInstallationRepos).toHaveLength(0);
  });

  it("passes the stored installationId to the client, then filters", async () => {
    const repos = [
      { id: 1, name: "empty-one", fullName: "acme/empty-one", owner: "acme", private: true, defaultBranch: "main", empty: true },
      { id: 3, name: "psalms-video", fullName: "acme/psalms-video", owner: "acme", private: false, defaultBranch: "main", empty: false },
    ];
    const { prisma } = makeFakePrisma({
      findUnique: () => ({ userId: "u1", installationId: "77" }),
    });
    const { client, calls } = makeFakeClient({
      listInstallationRepos: () => repos,
    });

    const empty = await service(prisma, client).listRepos("u1", {
      filter: "empty",
    });

    expect(calls.listInstallationRepos).toEqual([{ installationId: "77" }]);
    expect(empty.map((r) => r.id)).toEqual([1]);
  });
});
