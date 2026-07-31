import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import type { CreateRepoRequest } from "@supagloo/database-lib";
import {
  RepoProvisioningService,
  installationTokenRepoLister,
} from "./repo-provisioning-service";
import type { GithubAppClient } from "../connections/github-app-client";
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
 * The App client the visibility gate reads the INSTALLATION's own listing through
 * (`GET /installation/repositories`, minting its own installation token).
 *
 * `fullNames` is a function of the probe number so a listing can change between probes —
 * the whole point of a gate is that the answer is allowed to be "not yet".
 */
function recordingAppClient(
  fullNames: (probe: number) => string[] = () => ["acme/psalm-121"],
) {
  const probes: Array<{ installationId: string; deriveEmptinessFor: unknown }> = [];
  const appClient: Pick<GithubAppClient, "listInstallationRepos"> = {
    listInstallationRepos: async ({ installationId, deriveEmptinessFor }) => {
      probes.push({ installationId, deriveEmptinessFor });
      return fullNames(probes.length).map((fullName, i) => ({
        id: i + 1,
        name: fullName.split("/")[1],
        fullName,
        owner: fullName.split("/")[0],
        private: true,
        defaultBranch: "main",
        empty: true,
      }));
    },
  };
  return { appClient, probes };
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
    const { appClient } = recordingAppClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma(null),
      userAuthClient: client,
      appClient,
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
    const { appClient } = recordingAppClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma(null),
      userAuthClient: client,
      appClient,
      createProject,
    });
    await expect(svc.createRepoAndProject("u1", REQ)).rejects.toThrow(
      GithubNotConnectedError,
    );
  });

  it("selected-mode: exchanges, creates repo, adds to installation, delegates create", async () => {
    const { client, calls } = recordingUserAuthClient();
    const { appClient, probes } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "selected" }),
      userAuthClient: client,
      appClient,
      createProject,
    });

    const result = await svc.createRepoAndProject("u1", REQ);

    expect(result).toEqual({ projectId: "cprj1", jobId: "job-1" });
    // Everything the USER token is used for, in order — and it stops at the create.
    expect(calls).toEqual([
      "exchangeCode:gh-code",
      "createUserRepo:ghu_stub_user_1:psalm-121:true",
      "addRepoToInstallation:42:7",
    ]);
    // …and the visibility gate runs LAST, before the enqueue (DR1, below), against the
    // INSTALLATION's own listing rather than the user's.
    expect(probes).toHaveLength(1);
    expect(probes[0].installationId).toBe("42");
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
    const { appClient, probes } = recordingAppClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(calls).toEqual([
      "exchangeCode:gh-code",
      "createUserRepo:ghu_stub_user_1:psalm-121:true",
    ]);
    expect(calls.some((c) => c.startsWith("addRepoToInstallation"))).toBe(false);
    // …but the visibility gate still runs: an all-repos installation covers a new repo
    // automatically, and that is exactly the case that is not INSTANT.
    expect(probes).toHaveLength(1);
  });

  it("wraps a user-auth/create failure as RepoCreationError", async () => {
    const { client } = recordingUserAuthClient({
      exchangeCode: async () => {
        throw new Error("boom");
      },
    });
    const { appClient } = recordingAppClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "selected" }),
      userAuthClient: client,
      appClient,
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
    const { appClient } = recordingAppClient();
    const { createProject } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
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
      installationId,
    }: {
      installationId: string;
    }) => {
      probes.push(installationId);
      return pages[Math.min(probes.length - 1, pages.length - 1)];
    };
    return { listInstallationRepos, probes };
  }

  /**
   * U-RP1 — THE ENDPOINT CHOICE, pinned rather than incidental.
   *
   * The gate exists to predict whether dbos's `ensureRepoReachable` will find the repo,
   * and that step walks `GET /installation/repositories`. Until 2026-07-31 this gate
   * asked a DIFFERENT question — `GET /user/installations/:id/repositories`, the user's
   * view — which was indirect in production and outright unreachable in the browser e2e,
   * where the synthetic token exchange yields a classic PAT and GitHub answers 403 to
   * anything but a user-to-server token on that route (`E-RNP1b`, red since 2026-07-25).
   *
   * Two claims here, and the second is what stops a future rewire from being silent:
   *  1. the default lister goes through the APP client (installation token, installation
   *     listing), carrying only the installation id;
   *  2. the user-auth client is not consulted for a listing at all — it no longer even
   *     exposes one, so this assertion is about the whole call sequence, not one name.
   */
  it("U-RP1: the gate reads the INSTALLATION's own listing through the App client, never the user's", async () => {
    const clock = fakeClock();
    const { client, calls } = recordingUserAuthClient();
    const { appClient, probes } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(probes).toEqual([{ installationId: "42", deriveEmptinessFor: undefined }]);
    // The user token's last use is the create — nothing after it touches the user client.
    expect(calls).toEqual([
      "exchangeCode:gh-code",
      "createUserRepo:ghu_stub_user_1:psalm-121:true",
    ]);
    expect(createCalls).toHaveLength(1);
  });

  /**
   * U-RP2 — and the listing must stay CHEAP.
   *
   * `GithubAppClient.listInstallationRepos` takes an opt-in `deriveEmptinessFor`
   * predicate that fans a `GET /repos/:o/:r/commits` probe out over every `size === 0`
   * repo in the installation (measured at 55 for the live account). The gate polls in a
   * loop, inside a request a browser is holding open, and never reads `empty`. Passing
   * that predicate here would multiply the whole gate's request cost by the size of the
   * user's account to compute a field it discards.
   */
  it("U-RP2: the gate's listing never asks for the emptiness probe", async () => {
    const seen: unknown[] = [];
    const lister = installationTokenRepoLister({
      listInstallationRepos: async (args) => {
        seen.push(args.deriveEmptinessFor);
        return [
          {
            id: 7,
            name: "psalm-121",
            fullName: "acme/psalm-121",
            owner: "acme",
            private: true,
            defaultBranch: "main",
            empty: true,
          },
        ];
      },
    });

    await expect(lister({ installationId: "42" })).resolves.toEqual([
      "acme/psalm-121",
    ]);
    expect(seen).toEqual([undefined]);
  });

  it("adds NO wait when the created repo is already visible to the installation", async () => {
    const clock = fakeClock();
    const { client } = recordingUserAuthClient();
    const { appClient, probes } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
    });

    await svc.createRepoAndProject("u1", REQ);

    // One listing, ZERO sleeps: the common case pays a single round-trip, never a delay.
    expect(probes).toHaveLength(1);
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
    const { client } = recordingUserAuthClient();
    const { appClient } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
      listInstallationRepos: listing.listInstallationRepos,
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(createCalls).toHaveLength(1);
    // Three probes, all for the SAME installation — and carrying nothing else.
    expect(listing.probes).toEqual(["42", "42", "42"]);
  });

  it("matches the repo full name case-insensitively", async () => {
    const clock = fakeClock();
    const { client } = recordingUserAuthClient();
    const { appClient } = recordingAppClient(() => ["ACME/Psalm-121"]);
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
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
    const { client } = recordingUserAuthClient();
    const { appClient } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
      listInstallationRepos: async () => {
        n += 1;
        if (n === 1) throw new Error("GitHub 503 on /installation/repositories");
        return ["acme/psalm-121"];
      },
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(clock.sleeps).toEqual([1000]);
    expect(createCalls).toHaveLength(1);
  });

  it("NEVER enqueues when the repo never becomes visible — it throws RepoNotVisibleError", async () => {
    const clock = fakeClock();
    const { client } = recordingUserAuthClient();
    const { appClient } = recordingAppClient(() => ["acme/some-other-repo"]);
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
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

  // The gate's listing is still a SEAM over the App-client default — the mechanism the
  // scripted-listing cases above use to say "not yet, not yet, now". Nothing OUTSIDE this
  // file overrides it any more (the api e2e runs the real path since 2026-07-31), so this
  // case is what keeps the seam honest.
  it("uses an injected lister in preference to the App client's", async () => {
    const clock = fakeClock();
    const { client } = recordingUserAuthClient();
    const { appClient, probes } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const injected: string[] = [];
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
      listInstallationRepos: async ({ installationId }) => {
        injected.push(installationId);
        return ["acme/psalm-121"];
      },
    });

    await svc.createRepoAndProject("u1", REQ);

    expect(injected).toEqual(["42"]);
    expect(probes).toHaveLength(0);
    expect(createCalls).toHaveLength(1);
  });

  it("names the last probe failure when the gate expires on a broken listing", async () => {
    const clock = fakeClock();
    const { client } = recordingUserAuthClient();
    const { appClient } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
      sleep: clock.sleep,
      now: clock.now,
      installationVisibility: { timeoutMs: 3_000 },
      listInstallationRepos: async () => {
        throw new Error("GitHub 401 Requires authentication");
      },
    });

    const err = await svc.createRepoAndProject("u1", REQ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RepoNotVisibleError);
    expect((err as Error).message).toContain("401 Requires authentication");
    expect(createCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Feature 2 — the OTHER wizard payload site
// ---------------------------------------------------------------------------
//
// The wizard has two submit paths: the "create new repo" tab posts here, the "use
// existing empty repo" tab posts straight to `POST /v1/projects`. Carrying the passage on
// only one of them would make the feature work on one tab and silently do nothing on the
// other — with no error on either, because the delegate simply never sees the field.

describe("RepoProvisioningService.createRepoAndProject — the picked passage (feature 2)", () => {
  const SCRIPTURE = {
    reference: "Psalm 121",
    translation: "ASV",
    language: "en",
    passageId: "PSA.121",
  };

  it("U-W21: forwards scripture + createdFrom to the create-project delegate", async () => {
    const { client } = recordingUserAuthClient();
    const { appClient } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
    });

    await svc.createRepoAndProject("u1", {
      ...REQ,
      createdFrom: "passage",
      scripture: SCRIPTURE,
    } as any);

    expect(createCalls[0].req).toMatchObject({
      createdFrom: "passage",
      scripture: SCRIPTURE,
    });
  });

  it("U-W22: a blank project forwards no scripture key at all", async () => {
    const { client } = recordingUserAuthClient();
    const { appClient } = recordingAppClient();
    const { createProject, calls: createCalls } = recordingCreateProject();
    const svc = new RepoProvisioningService({
      prisma: makeFakePrisma({ installationId: "42", repositorySelection: "all" }),
      userAuthClient: client,
      appClient,
      createProject,
    });

    await svc.createRepoAndProject("u1", REQ);

    expect("scripture" in (createCalls[0].req as object)).toBe(false);
  });
});
