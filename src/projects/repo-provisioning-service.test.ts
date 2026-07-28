import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import type { CreateRepoRequest } from "@supagloo/database-lib";
import { RepoProvisioningService } from "./repo-provisioning-service";
import {
  RepoCreationError,
  RepoNotVisibleError,
} from "./repo-provisioning-errors";
import { GithubNotConnectedError } from "../connections/errors";
import {
  GithubCreateRepoError,
  type GithubUserAuthClient,
} from "../connections/github-user-auth-client";

// The create-new-repo JIT orchestration (Task #26, design-delta §2.3/§6b): read the
// user's installation, exchange the code for a user token, create the repo, add it to
// a `selected`-mode installation, discard the token, then delegate to the existing
// create-project+scaffold path — returning the SAME { projectId, jobId }. A pure
// DB reader + injected user-auth client + injected createProject seam, so every
// branch is unit-testable with fakes.

const REQ: CreateRepoRequest = {
  code: "gh-code",
  name: "Psalm 121",
  repoName: "psalm-121",
  visibility: "private",
  createdFrom: "blank",
};

interface Connection {
  installationId: string;
  repositorySelection: string;
}

function makeFakePrisma(connection: Connection | null) {
  return {
    githubConnection: {
      findUnique: async () => connection,
    },
  } as unknown as PrismaClient;
}

function recordingUserAuthClient(overrides: Partial<GithubUserAuthClient> = {}) {
  const calls: string[] = [];
  const client: GithubUserAuthClient = {
    buildAuthorizeUrl: ({ redirectUri, state }) => {
      calls.push("buildAuthorizeUrl");
      return `https://github.com/login/oauth/authorize?redirect_uri=${redirectUri}&state=${state}`;
    },
    exchangeCode: async (code) => {
      calls.push(`exchangeCode:${code}`);
      return { token: "ghu_stub_user_1" };
    },
    createUserRepo: async ({ token, name, private: priv }) => {
      calls.push(`createUserRepo:${token}:${name}:${priv}`);
      return {
        id: 7,
        name: "psalm-121",
        fullName: "acme/psalm-121",
        owner: "acme",
        private: priv,
        defaultBranch: "main",
        cloneUrl: "https://github.com/octo-test/psalm-121.git",
      };
    },
    addRepoToInstallation: async ({ installationId, repositoryId }) => {
      calls.push(`addRepoToInstallation:${installationId}:${repositoryId}`);
    },
    listInstallationRepos: async ({ token, installationId }) => {
      calls.push(`listInstallationRepos:${token}:${installationId}`);
      // Default: the created repo is ALREADY visible, i.e. the common case.
      return ["acme/psalm-121"];
    },
    // Part of the client interface but never reached from repo provisioning — it
    // belongs to the connection surface's link-existing path. Recorded anyway, so a
    // stray call here would show up rather than pass silently.
    listUserInstallations: async (token) => {
      calls.push(`listUserInstallations:${token}`);
      return [];
    },
    ...overrides,
  };
  return { client, calls };
}

/**
 * A clock + sleep pair the visibility gate can be driven with, so no unit test ever
 * really waits: `sleep` records the delay and ADVANCES the fake clock by it, which is
 * what lets a bounded-deadline loop terminate in microseconds.
 */
function fakeClock(startMs = 1_700_000_000_000) {
  let nowMs = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  };
}

function recordingCreateProject() {
  const calls: { userId: string; req: unknown }[] = [];
  const createProject = async (userId: string, req: unknown) => {
    calls.push({ userId, req });
    return { projectId: "cprj1", jobId: "job-1" };
  };
  return { createProject, calls };
}

describe("RepoProvisioningService.authorizeUrl", () => {
  it("delegates to the user-auth client's buildAuthorizeUrl", () => {
    const { client } = recordingUserAuthClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma(null),
      userAuthClient: client,
      createProject,
    });
    const url = svc.authorizeUrl({
      redirectUri: "https://app.example/cb",
      state: "n1",
    });
    expect(url).toContain("state=n1");
    expect(url).toContain("redirect_uri=https://app.example/cb");
  });
});

describe("RepoProvisioningService.createRepoAndProject", () => {
  it("rejects with GithubNotConnectedError when the user has no connection", async () => {
    const { client } = recordingUserAuthClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma(null),
      userAuthClient: client,
      createProject,
    });
    await expect(svc.createRepoAndProject("u1", REQ)).rejects.toThrow(
      GithubNotConnectedError,
    );
  });

  it("selected-mode: exchanges, creates repo, adds to installation, delegates create", async () => {
    const { client, calls } = recordingUserAuthClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "selected" }),
      userAuthClient: client,
      createProject,
    });

    const result = await svc.createRepoAndProject("u1", REQ);

    expect(result).toEqual({ projectId: "cprj1", jobId: "job-1" });
    expect(calls).toEqual([
      "exchangeCode:gh-code",
      "createUserRepo:ghu_stub_user_1:psalm-121:true",
      "addRepoToInstallation:42:7",
      // The visibility gate runs LAST, before the enqueue (DR1, below).
      "listInstallationRepos:ghu_stub_user_1:42",
    ]);
    // delegates to createProject with the CREATED repo's owner + name (from GitHub).
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].userId).toBe("u1");
    expect(createCalls[0].req).toMatchObject({
      repoOwner: "acme",
      repoName: "psalm-121",
      visibility: "private",
      createdFrom: "blank",
      name: "Psalm 121",
    });
  });

  it("all-mode installation: skips the installation-add step", async () => {
    const { client, calls } = recordingUserAuthClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(calls).toEqual([
      "exchangeCode:gh-code",
      "createUserRepo:ghu_stub_user_1:psalm-121:true",
      // …but the visibility gate still runs: an all-repos installation covers a new
      // repo automatically, and that is exactly the case that is not INSTANT.
      "listInstallationRepos:ghu_stub_user_1:42",
    ]);
    expect(calls.some((c) => c.startsWith("addRepoToInstallation"))).toBe(false);
  });

  it("wraps a user-auth/create failure as RepoCreationError", async () => {
    const { client } = recordingUserAuthClient({
      exchangeCode: async () => {
        throw new Error("boom");
      },
    });
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "selected" }),
      userAuthClient: client,
      createProject,
    });
    await expect(svc.createRepoAndProject("u1", REQ)).rejects.toThrow(RepoCreationError);
  });

  // --------------------------------------------------------------- plan row 63
  // Today every create failure collapses into the same opaque `502
  // repo_creation_failed` — a 422 "name already exists", a 401 bad token and a 503
  // are byte-identical to the caller. The route's status code and error slug are
  // contract-pinned and do NOT change; what changes is that the upstream status
  // survives on the error so the message can name it (D63.5).
  it("preserves the upstream GitHub status on RepoCreationError", async () => {
    const { client } = recordingUserAuthClient({
      createUserRepo: async () => {
        throw new GithubCreateRepoError(
          "GitHub create-repo failed for psalm-121: 422 — name already exists on this account",
          { upstreamStatus: 422 },
        );
      },
    });
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
    });

    const err = await svc.createRepoAndProject("u1", REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoCreationError);
    expect((err as RepoCreationError).upstreamStatus).toBe(422);
    expect((err as Error).message).toContain("422");
  });
});

// ----------------------------------------------------- DR1: the visibility race
// `createRepoAndProject` used to POST /user/repos and enqueue the scaffold workflow in
// the very next statement. That workflow's step 2 (`ensureRepoReachable`, dbos
// `scaffold-project/github-rest.ts`) walks GET /installation/repositories and throws
// `RepoUnreachableError` when the repo is absent — a type `isPermanentScaffoldFailure`
// classifies as PERMANENT, so `shouldRetry` is false and the step fails on its FIRST
// attempt with no DBOS retry at all. Under `repository_selection: "all"` a brand-new
// repo IS covered by the installation, but not INSTANTLY.
//
// The e2e harness has gated on this since task 62
// (`tests/support/e2e-github-api.mjs` `waitForInstallationVisibility`, "Gate #2 before
// any workflow enqueue"); the PRODUCT did not. Row 63's `markJobFailed` made the
// consequence louder, not rarer: the user gets an immediate hard `failed` and a real,
// empty GitHub repo they never asked to keep.
describe("RepoProvisioningService.createRepoAndProject — installation-visibility gate", () => {
  /** Scripted listing pages, plus a probe counter — the last page repeats forever. */
  function scriptedListing(pages: string[][]) {
    const probes: string[] = [];
    const listInstallationRepos = async ({
      token,
      installationId,
    }: {
      token: string;
      installationId: string;
    }) => {
      probes.push(`${token}:${installationId}`);
      return pages[Math.min(probes.length - 1, pages.length - 1)];
    };
    return { listInstallationRepos, probes };
  }

  it("adds NO wait when the created repo is already visible to the installation", async () => {
    const clock = fakeClock();
    const { client, calls } = recordingUserAuthClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
    });

    await svc.createRepoAndProject("u1", REQ);

    // One listing, ZERO sleeps: the common case pays a single round-trip, never a delay.
    expect(calls.filter((c) => c.startsWith("listInstallationRepos"))).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(createCalls).toHaveLength(1);
  });

  it("polls with capped exponential backoff until the repo appears, THEN enqueues", async () => {
    const clock = fakeClock();
    const listing = scriptedListing([
      [],
      ["acme/other"],
      ["acme/other", "acme/psalm-121"],
    ]);
    const { client } = recordingUserAuthClient({
      listInstallationRepos: listing.listInstallationRepos,
    });
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(createCalls).toHaveLength(1);
    // Three probes, all with the SAME short-lived user token that created the repo.
    expect(listing.probes).toEqual([
      "ghu_stub_user_1:42",
      "ghu_stub_user_1:42",
      "ghu_stub_user_1:42",
    ]);
  });

  it("matches the repo full name case-insensitively", async () => {
    const clock = fakeClock();
    const { client } = recordingUserAuthClient({
      listInstallationRepos: async () => ["ACME/Psalm-121"],
    });
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
    });

    await svc.createRepoAndProject("u1", REQ);
    expect(createCalls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("treats a failing probe as 'not yet' and keeps polling inside the window", async () => {
    const clock = fakeClock();
    let n = 0;
    const { client } = recordingUserAuthClient({
      listInstallationRepos: async () => {
        n += 1;
        if (n === 1) throw new Error("GitHub 503 on /user/installations/42/repositories");
        return ["acme/psalm-121"];
      },
    });
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(clock.sleeps).toEqual([1000]);
    expect(createCalls).toHaveLength(1);
  });

  it("NEVER enqueues when the repo never becomes visible — it throws RepoNotVisibleError", async () => {
    const clock = fakeClock();
    const { client } = recordingUserAuthClient({
      listInstallationRepos: async () => ["acme/some-other-repo"],
    });
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
    });

    const err = await svc.createRepoAndProject("u1", REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RepoNotVisibleError);
    // …and it is a RepoCreationError, so the route keeps answering with the
    // contract-pinned 502 + `repo_creation_failed` instead of falling through to
    // Fastify's default 500 handler.
    expect(err).toBeInstanceOf(RepoCreationError);
    expect((err as RepoCreationError).statusCode).toBe(502);
    expect((err as Error).message).toContain("acme/psalm-121");
    // The whole point: no workflow was enqueued on a hope.
    expect(createCalls).toHaveLength(0);
    // Bounded by the 60s default, with the delay capped at 5s (the harness's shape).
    const waited = clock.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(60_000);
    expect(Math.max(...clock.sleeps)).toBe(5_000);
  });

  // The gate's listing is a SEAM, defaulting to the user-auth client. An injected
  // lister replaces it wholesale — that is how the e2e reads the installation-token
  // view (`GET /installation/repositories`, dbos's own view), which the user-to-server
  // endpoint cannot stand in for there because GitHub requires a token AUTHORIZED TO
  // THE APP and the e2e fakes the token's provenance with a PAT.
  it("uses an injected lister in preference to the user-auth client", async () => {
    const clock = fakeClock();
    const { client, calls } = recordingUserAuthClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const injected: string[] = [];
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
      listInstallationRepos: async ({ token, installationId }) => {
        injected.push(`${token}:${installationId}`);
        return ["acme/psalm-121"];
      },
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(injected).toEqual(["ghu_stub_user_1:42"]);
    expect(calls.some((c) => c.startsWith("listInstallationRepos"))).toBe(false);
    expect(createCalls).toHaveLength(1);
  });

  it("names the last probe failure when the gate expires on a broken listing", async () => {
    const clock = fakeClock();
    const { client } = recordingUserAuthClient({
      listInstallationRepos: async () => {
        throw new Error("GitHub 401 Requires authentication");
      },
    });
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
      installationVisibility: { timeoutMs: 3_000 },
    });

    const err = await svc.createRepoAndProject("u1", REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RepoNotVisibleError);
    expect((err as Error).message).toContain("401 Requires authentication");
    expect(createCalls).toHaveLength(0);
  });
});
