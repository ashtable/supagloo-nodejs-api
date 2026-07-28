import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import {
  GithubConnectionService,
  selectInstallation,
} from "./github-connection-service";
import {
  AmbiguousUserInstallationError,
  InstallationVerificationError,
  GithubNotConnectedError,
  NoUserInstallationError,
} from "./errors";

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

interface UserAuthOverrides {
  exchangeCode?: Fn;
  listUserInstallations?: Fn;
}

/** The USER-authorization surface behind `linkExisting`, faked the same way as the
 *  App-JWT client above: recorded calls, overridable per test, no network. */
function makeFakeUserAuth(overrides: UserAuthOverrides = {}) {
  const calls = {
    buildAuthorizeUrl: [] as any[],
    exchangeCode: [] as any[],
    listUserInstallations: [] as any[],
  };
  return {
    calls,
    userAuth: {
      buildAuthorizeUrl: (args: { redirectUri: string; state: string }) => {
        calls.buildAuthorizeUrl.push(args);
        return (
          "https://github.com/login/oauth/authorize?client_id=cid" +
          `&redirect_uri=${encodeURIComponent(args.redirectUri)}` +
          `&state=${encodeURIComponent(args.state)}`
        );
      },
      exchangeCode: async (code: string) => {
        calls.exchangeCode.push(code);
        return overrides.exchangeCode
          ? overrides.exchangeCode(code)
          : { token: "ghu_test" };
      },
      listUserInstallations: async (token: string) => {
        calls.listUserInstallations.push(token);
        return overrides.listUserInstallations
          ? overrides.listUserInstallations(token)
          : [
              {
                installationId: "42",
                accountLogin: "acme",
                targetType: "User",
              },
            ];
      },
    },
  };
}

function service(
  prisma: PrismaClient,
  client: ReturnType<typeof makeFakeClient>["client"],
  userAuth: ReturnType<typeof makeFakeUserAuth>["userAuth"] = makeFakeUserAuth()
    .userAuth,
) {
  return new GithubConnectionService({
    prisma,
    verifyInstallation: client.verifyInstallation,
    listInstallationRepos: client.listInstallationRepos,
    oauthBaseUrl: "https://github.com",
    appSlug: "supagloo-app",
    userAuth,
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

    expect(calls.listInstallationRepos).toHaveLength(1);
    expect(calls.listInstallationRepos[0].installationId).toBe("77");
    expect(empty.map((r) => r.id)).toEqual([1]);
  });
});

// ===========================================================================
// deferred review finding DR2 — WHO PAYS FOR THE EMPTINESS PROBE.
//
// The row-65 probe fans out over every `size: 0` repo in the FULL installation
// listing, inside `listInstallationRepos` — i.e. BEFORE this service applies
// `filterRepos(repos, {filter, q})`. Two costs followed:
//
//   1. `GET /v1/github/repos` is not only the repo picker: nextjs's
//      `SessionProvider` calls it on EVERY hard page load, unfiltered, to render an
//      "N repos accessible" count that never reads `empty`. On the live installation
//      that was ~62 GitHub requests per page load (582 repos / 6 pages / 55 `size: 0`)
//      against a ~5,000/hour budget — ~80 page loads to exhaustion.
//   2. `?filter=empty&q=<name>` narrows to ONE repo and still paid the full fan-out.
//
// This service is where the caller's intent is known, so this is where it is
// converted into a probe budget: the client is told exactly which repos need an
// authoritative verdict, and is told NOTHING when the query cannot use one.
// ===========================================================================

describe("GithubConnectionService.listRepos — probe intent (DR2)", () => {
  const REPOS = [
    { id: 1, name: "alpha", fullName: "acme/alpha", owner: "acme", private: true, defaultBranch: "main", empty: true },
    { id: 2, name: "beta", fullName: "acme/beta", owner: "acme", private: true, defaultBranch: "main", empty: true },
    { id: 3, name: "alpha-full", fullName: "acme/alpha-full", owner: "acme", private: false, defaultBranch: "main", empty: false },
  ];

  const connected = () =>
    makeFakePrisma({ findUnique: () => ({ userId: "u1", installationId: "77" }) });

  /** The predicate the service handed the client, or null when it handed none. */
  const probeIntent = (calls: any[]) =>
    (calls[0].deriveEmptinessFor as ((r: any) => boolean) | undefined) ?? null;

  it("asks for NO emptiness verdict on the unnarrowed filter=all listing", async () => {
    // The `SessionProvider` repo-count call, on every page load. It renders a COUNT;
    // it never reads `empty`. Zero probes is the only correct cost.
    const { prisma } = connected();
    const { client, calls } = makeFakeClient({ listInstallationRepos: () => REPOS });

    await service(prisma, client).listRepos("u1", { filter: "all" });

    expect(probeIntent(calls.listInstallationRepos)).toBeNull();
  });

  it("asks for a verdict on every candidate when filter=empty carries no q", async () => {
    // Wireframe 13a's "use existing empty repo" tab: `empty` GATES the picker row, so
    // the fan-out is genuinely earned here — and it is paid when the user opens that
    // tab, not on every page load of every page.
    const { prisma } = connected();
    const { client, calls } = makeFakeClient({ listInstallationRepos: () => REPOS });

    await service(prisma, client).listRepos("u1", { filter: "empty" });

    const intent = probeIntent(calls.listInstallationRepos);
    expect(intent).not.toBeNull();
    expect(REPOS.filter((r) => intent!(r)).map((r) => r.id)).toEqual([1, 2]);
  });

  it("narrows the verdict set by q, so a single-repo query costs a single probe", async () => {
    const { prisma } = connected();
    const { client, calls } = makeFakeClient({ listInstallationRepos: () => REPOS });

    await service(prisma, client).listRepos("u1", { filter: "empty", q: "alpha" });

    const intent = probeIntent(calls.listInstallationRepos);
    expect(intent).not.toBeNull();
    // `alpha-full` matches `q` but is not a candidate; `beta` is a candidate but does
    // not match `q`. Exactly one repo survives BOTH.
    expect(REPOS.filter((r) => intent!(r)).map((r) => r.id)).toEqual([1]);
  });

  it("asks for a verdict on a narrowed filter=all query too (q= is a targeted lookup)", async () => {
    // `?filter=all&q=<exact name>` is how the api e2e reads a specific repo's verdict,
    // and how a caller checks one repo. Its fan-out is bounded by the narrowing, so
    // the answer can be authoritative without costing the whole account.
    const { prisma } = connected();
    const { client, calls } = makeFakeClient({ listInstallationRepos: () => REPOS });

    await service(prisma, client).listRepos("u1", { filter: "all", q: "alpha" });

    const intent = probeIntent(calls.listInstallationRepos);
    expect(intent).not.toBeNull();
    // The predicate is the NARROWING and nothing else: it admits the `q` matches and
    // rejects `beta`. It deliberately does NOT re-implement the `size > 0`
    // short-circuit — that stays the client's single responsibility (pinned there by
    // "still short-circuits size > 0 even when the caller admits every repo"), so the
    // two layers cannot drift into disagreeing about what "already answered" means.
    expect(REPOS.filter((r) => intent!(r)).map((r) => r.id)).toEqual([1, 3]);
    expect(intent!(REPOS[1])).toBe(false);
  });

  it("treats a blank/whitespace q as no narrowing at all (matches filterRepos)", async () => {
    const { prisma } = connected();
    const { client, calls } = makeFakeClient({ listInstallationRepos: () => REPOS });

    await service(prisma, client).listRepos("u1", { filter: "all", q: "   " });

    expect(probeIntent(calls.listInstallationRepos)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Linking an installation the user ALREADY has (the user-authorization hop).
//
// This path exists because the install callback structurally cannot cover it:
// GitHub redirects to the App's Setup URL only when an installation is CREATED, so a
// reinstall, an install made from GitHub's own directory, or one App registration
// shared across environments produces no callback and no installationId at all.
// ---------------------------------------------------------------------------

const inst = (
  installationId: string,
  accountLogin: string,
  targetType: string | null,
) => ({ installationId, accountLogin, targetType });

describe("selectInstallation", () => {
  it("returns the only installation when there is exactly one", () => {
    expect(selectInstallation([inst("1", "ash", "User")]).installationId).toBe("1");
  });

  it("returns the single ORG installation when that is all there is", () => {
    expect(
      selectInstallation([inst("7", "acme", "Organization")]).installationId,
    ).toBe("7");
  });

  it("prefers the user's own account over their organizations", () => {
    const chosen = selectInstallation([
      inst("7", "acme", "Organization"),
      inst("1", "ash", "User"),
      inst("9", "globex", "Organization"),
    ]);
    expect(chosen.installationId).toBe("1");
    expect(chosen.accountLogin).toBe("ash");
  });

  it("throws NoUserInstallation when the user has none", () => {
    expect(() => selectInstallation([])).toThrow(NoUserInstallationError);
  });

  /**
   * The refusal that matters. GitHub documents no ordering for this listing, so
   * picking one here would attach the user's repositories to whichever account
   * happened to be listed first — wrong, silent, and persisted.
   */
  it("REFUSES to guess between several orgs with no personal account", () => {
    expect(() =>
      selectInstallation([
        inst("7", "acme", "Organization"),
        inst("9", "globex", "Organization"),
      ]),
    ).toThrow(AmbiguousUserInstallationError);
  });

  it("names the candidate accounts in the ambiguity error", () => {
    expect(() =>
      selectInstallation([
        inst("7", "acme", "Organization"),
        inst("9", "globex", "Organization"),
      ]),
    ).toThrow(/acme, globex/);
  });

  it("refuses when several personal installations somehow appear", () => {
    expect(() =>
      selectInstallation([inst("1", "a", "User"), inst("2", "b", "User")]),
    ).toThrow(AmbiguousUserInstallationError);
  });

  /** A null targetType must not be mistaken for a personal account. */
  it("does not treat an unknown targetType as personal", () => {
    expect(() =>
      selectInstallation([inst("7", "acme", null), inst("9", "globex", null)]),
    ).toThrow(AmbiguousUserInstallationError);
  });
});

describe("GithubConnectionService.linkExisting", () => {
  it("exchanges the code, resolves the installation, and stores the connection", async () => {
    const { prisma, calls: prismaCalls } = makeFakePrisma();
    const { client } = makeFakeClient();
    const { userAuth, calls } = makeFakeUserAuth();

    const connection = await service(prisma, client, userAuth).linkExisting(
      "u1",
      "code-abc",
    );

    expect(calls.exchangeCode).toEqual(["code-abc"]);
    // The token from the exchange is what reads the installations — and it is used
    // for that one call only, never persisted.
    expect(calls.listUserInstallations).toEqual(["ghu_test"]);
    expect(connection.installationId).toBe("42");
    expect(prismaCalls.upsert).toHaveLength(1);
    expect(prismaCalls.upsert[0].create.status).toBe("connected");
  });

  /**
   * The resolved id still goes through the App-JWT verify, so `githubLogin` and
   * `repositorySelection` come from GitHub rather than from the user-token listing —
   * one persistence path, one verification path, shared with the install callback.
   */
  it("App-JWT verifies the resolved installation rather than trusting the listing", async () => {
    const { prisma, calls: prismaCalls } = makeFakePrisma();
    const { client, calls: clientCalls } = makeFakeClient({
      verifyInstallation: () => ({
        githubLogin: "verified-login",
        repositorySelection: "all",
      }),
    });
    const { userAuth } = makeFakeUserAuth({
      // The user-token listing claims a DIFFERENT login than the App-JWT verify.
      // What lands in the row must come from the verify.
      listUserInstallations: () => [inst("42", "listing-login", "User")],
    });

    await service(prisma, client, userAuth).linkExisting("u1", "code-abc");

    expect(clientCalls.verifyInstallation).toEqual(["42"]);
    expect(prismaCalls.upsert[0].create.githubLogin).toBe("verified-login");
    expect(prismaCalls.upsert[0].create.repositorySelection).toBe("all");
  });

  it("propagates NoUserInstallation and writes nothing", async () => {
    const { prisma, calls: prismaCalls } = makeFakePrisma();
    const { client } = makeFakeClient();
    const { userAuth } = makeFakeUserAuth({ listUserInstallations: () => [] });

    await expect(
      service(prisma, client, userAuth).linkExisting("u1", "code-abc"),
    ).rejects.toThrow(NoUserInstallationError);
    expect(prismaCalls.upsert).toHaveLength(0);
  });

  it("propagates the ambiguity refusal and writes nothing", async () => {
    const { prisma, calls: prismaCalls } = makeFakePrisma();
    const { client } = makeFakeClient();
    const { userAuth } = makeFakeUserAuth({
      listUserInstallations: () => [
        inst("7", "acme", "Organization"),
        inst("9", "globex", "Organization"),
      ],
    });

    await expect(
      service(prisma, client, userAuth).linkExisting("u1", "code-abc"),
    ).rejects.toThrow(AmbiguousUserInstallationError);
    expect(prismaCalls.upsert).toHaveLength(0);
  });

  /** A rejected authorization code must never reach the installations read. */
  it("does not list installations when the code exchange fails", async () => {
    const { prisma } = makeFakePrisma();
    const { client } = makeFakeClient();
    const { userAuth, calls } = makeFakeUserAuth({
      exchangeCode: () => {
        throw new Error("bad_verification_code");
      },
    });

    await expect(
      service(prisma, client, userAuth).linkExisting("u1", "code-abc"),
    ).rejects.toThrow(/bad_verification_code/);
    expect(calls.listUserInstallations).toEqual([]);
  });

  /** Upsert-by-userId, so re-linking replaces rather than duplicating or failing. */
  it("re-links an already-connected user by overwriting the stored installation", async () => {
    const { prisma, calls: prismaCalls } = makeFakePrisma({
      findUnique: () => ({ userId: "u1", installationId: "42" }),
    });
    const { client } = makeFakeClient();
    const { userAuth } = makeFakeUserAuth({
      listUserInstallations: () => [inst("99", "ash", "User")],
    });

    await service(prisma, client, userAuth).linkExisting("u1", "code-abc");

    expect(prismaCalls.upsert[0].where).toEqual({ userId: "u1" });
    expect(prismaCalls.upsert[0].create.installationId).toBe("99");
    expect(prismaCalls.upsert[0].update.installationId).toBe("99");
  });
});

describe("GithubConnectionService.authorizeUrl", () => {
  it("delegates to the user-auth client, carrying redirectUri and state", () => {
    const { prisma } = makeFakePrisma();
    const { client } = makeFakeClient();
    const { userAuth, calls } = makeFakeUserAuth();

    const url = service(prisma, client, userAuth).authorizeUrl({
      redirectUri: "http://localhost:8000/api/connect/github/callback",
      state: "nonce-1",
    });

    expect(calls.buildAuthorizeUrl).toEqual([
      {
        redirectUri: "http://localhost:8000/api/connect/github/callback",
        state: "nonce-1",
      },
    ]);
    expect(url).toContain("state=nonce-1");
  });
});
