import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { signAppJwt } from "@supagloo/database-lib";
import {
  GITHUB_APP_ID_VAR,
  GITHUB_APP_PRIVATE_KEY_VAR,
  GITHUB_APP_SLUG_VAR,
  GITHUB_E2E_ENV_VARS,
  GITHUB_E2E_OWNER_VAR,
  GITHUB_E2E_PAT_VAR,
  GITHUB_APP_INSTALL_URL,
  E2E_API_MODULE_RELPATH,
  E2E_NAMING_MODULE_RELPATH,
  ROOT_DIR_VAR,
  loadRootE2eHarness,
  provisionFixtureRepo,
  resolveGithubE2eContext,
  resolveGithubE2eSecrets,
  resolveRootRepoDir,
  seedRepoFileOnBranch,
  shimOnlyTheUserAuthorizationTokenExchange,
  resolveGithubOauthClientCreds,
  GITHUB_APP_CLIENT_ID_VAR,
  GITHUB_APP_CLIENT_SECRET_VAR,
  USER_AUTHORIZATION_TOKEN_EXCHANGE_URL,
  __resetGithubE2eMemoForTests,
} from "./github-e2e";

// Unit coverage for the api's real-GitHub e2e ADAPTER (task-62 D4). Everything here
// runs with an INJECTED module loader and an INJECTED env — zero network egress, zero
// filesystem dependency on a sibling checkout (HARD RULE 5 / design-delta §10.6). The
// adapter is test-only infrastructure (excluded from `dist/` by tsconfig.build.json),
// but its failure modes are exactly the ones that cost row 62 a debugging cycle, so
// they are unit-tested rather than discovered at 3am in a red e2e.
//
// DELIBERATE SPLIT (task-62 D3): the NETWORK harness has exactly ONE implementation, in
// the root repo (`tests/support/e2e-github-api.mjs`), and root's own
// `tests/unit/e2e-github-api.test.ts` (plan Phase 0.1) owns the assertions about
// discovery's five fail-fast throws, Link pagination and Retry-After backoff. What is
// api-side and therefore tested HERE:
//   • the env fail-fast (kept LOCAL so it fires before any file/network resolution)
//   • root-dir resolution + the actionable missing-file error
//   • the required-export contract (a loud, attributable throw if root's surface drifts)
//   • that the PRODUCT signer (db-lib `signAppJwt`) is what gets handed to discovery
//   • owner resolution, memoisation, and branch-then-put sequencing

// A REAL keypair, carried in the single-line escaped-`\n` form the root `.env`
// documents. Using the real form matters: `resolveGithubE2eContext` hands this string
// straight to db-lib's `signAppJwt`, so these cases also prove end-to-end that the
// escaped env form is signable — row 62 item (c)'s bug class, at zero extra cost.
const { privateKey: PEM_REAL } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const PEM_ESCAPED = PEM_REAL.replace(/\n/g, "\\n");

/** Sentinel stand-in for root's `E2E_REPO_PREFIX` — see the note in `fakeHarness`. */
const FAKE_PREFIX = "supagloo-fixture-prefix-under-test-";

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [GITHUB_APP_ID_VAR]: "4338011",
    [GITHUB_APP_SLUG_VAR]: "supagloo",
    [GITHUB_APP_PRIVATE_KEY_VAR]: PEM_ESCAPED,
    [GITHUB_E2E_PAT_VAR]: "ghp_fake_for_unit_test",
    ...overrides,
  } as Record<string, string | undefined>;
}

/** A fake of the two root harness modules, recording every call. */
function fakeHarness(
  overrides: {
    installations?: unknown;
    discover?: (args: any) => Promise<any>;
  } = {},
) {
  const calls: { name: string; args: any }[] = [];
  // Models real GitHub: `main` exists because fixture repos are created with
  // `auto_init: true`, and `createRef` really does make the branch visible.
  const branches = new Set<string>(["main"]);
  const record = (name: string) => (args: any) => {
    calls.push({ name, args });
    return args;
  };

  // A SENTINEL prefix, deliberately not the real one. The real prefix literal is
  // authored in exactly ONE file — root's tests/support/e2e-github-naming.mjs
  // (task-62 D1) — and root's own guard test asserts it appears nowhere else across
  // the four checkouts, so re-typing it here would break that guard. Using a sentinel here
  // also proves something better: the adapter works with WHATEVER root exports, and
  // never assumes a prefix value of its own.
  const naming = {
    E2E_REPO_PREFIX: FAKE_PREFIX,
    E2E_RUN_ID: "runid42",
    buildE2eRepoName: (slug: string, runId: string) =>
      `${FAKE_PREFIX}${slug}-${runId}`,
    isE2eRepoName: (name: string) => name.startsWith(FAKE_PREFIX),
  };

  const api = {
    resolveGithubE2eSecrets: record("resolveGithubE2eSecrets"),
    discoverInstallation:
      overrides.discover ??
      (async (args: any) => {
        calls.push({ name: "discoverInstallation", args });
        // Exercise the caller-supplied signer exactly as the real harness does.
        const jwt = args.signJwt
          ? args.signJwt({ appId: args.appId, privateKey: args.privateKey })
          : "no-signer";
        // root returns `ownerLogin` + `accountType`, NOT `owner`. The fake mirrors the
        // real module's shape on purpose: a fake that is kinder than reality is how a
        // cross-repo contract break reaches an e2e instead of a unit test.
        return {
          installationId: "9000001",
          ownerLogin: args.ownerLogin ?? "octo-owner",
          accountType: "User",
          repositorySelection: "all",
          jwtUsed: jwt,
        };
      }),
    // root builds the name itself and returns GitHub's RAW POST /user/repos body.
    createFixtureRepo: async (args: any) => {
      calls.push({ name: "createFixtureRepo", args });
      const name = naming.buildE2eRepoName(args.slug, args.runId);
      return {
        name,
        full_name: `octo-owner/${name}`,
        owner: { login: "octo-owner" },
        default_branch: "main",
        private: true,
      };
    },
    waitForRepoReady: async (args: any) => {
      calls.push({ name: "waitForRepoReady", args });
      return { sha: "basesha" };
    },
    waitForInstallationVisibility: async (args: any) => {
      calls.push({ name: "waitForInstallationVisibility", args });
      return true;
    },
    createRef: async (args: any) => {
      calls.push({ name: "createRef", args });
      branches.add(args.branch);
      return { ref: `refs/heads/${args.branch}` };
    },
    putContents: async (args: any) => {
      calls.push({ name: "putContents", args });
      return { commitSha: "c1" };
    },
    listBranches: async (args: any) => {
      calls.push({ name: "listBranches", args });
      return [...branches].map((name) => ({ name }));
    },
  };

  const importModule = async (href: string) => {
    if (href.includes("e2e-github-naming")) return naming;
    if (href.includes("e2e-github-api")) return api;
    throw new Error(`unexpected import: ${href}`);
  };

  /**
   * An injected `fetch` for the ONE call the adapter makes itself: the PRODUCT
   * installation-token mint (db-lib `mintInstallationToken`). Any other URL throws, so
   * this unit lane can never quietly acquire real network egress (HARD RULE 5).
   */
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ name: "fetch", args: { url, method: init?.method ?? "GET" } });
    if (url.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "ghs_installation_from_product_mint",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    throw new Error(`unit lane must not reach the network: ${url}`);
  }) as unknown as typeof fetch;

  return { calls, naming, api, importModule, fetchImpl };
}

beforeEach(() => {
  __resetGithubE2eMemoForTests();
});

// ------------------------------------------------------------------ env fail-fast

describe("resolveGithubE2eSecrets", () => {
  it("declares exactly the four required vars, in a stable order", () => {
    expect([...GITHUB_E2E_ENV_VARS]).toEqual([
      GITHUB_APP_ID_VAR,
      GITHUB_APP_SLUG_VAR,
      GITHUB_APP_PRIVATE_KEY_VAR,
      GITHUB_E2E_PAT_VAR,
    ]);
  });

  it("returns the four secrets when all are present", () => {
    const s = resolveGithubE2eSecrets(baseEnv());
    expect(s.appId).toBe("4338011");
    expect(s.appSlug).toBe("supagloo");
    expect(s.privateKey).toBe(PEM_ESCAPED);
    expect(s.pat).toBe("ghp_fake_for_unit_test");
  });

  for (const missing of [
    GITHUB_APP_ID_VAR,
    GITHUB_APP_SLUG_VAR,
    GITHUB_APP_PRIVATE_KEY_VAR,
    GITHUB_E2E_PAT_VAR,
  ]) {
    it(`throws naming ${missing}, the root .env and .env.example when it is missing`, () => {
      expect(() =>
        resolveGithubE2eSecrets(baseEnv({ [missing]: undefined })),
      ).toThrow(
        new RegExp(`${missing}[\\s\\S]*\\.env`),
      );
      // The message must be actionable: it names the file the value belongs in.
      let message = "";
      try {
        resolveGithubE2eSecrets(baseEnv({ [missing]: undefined }));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(".env.example");
      expect(message).toContain(missing);
    });

    it(`treats a blank ${missing} as missing (whitespace is not a credential)`, () => {
      expect(() =>
        resolveGithubE2eSecrets(baseEnv({ [missing]: "   " })),
      ).toThrow(new RegExp(missing));
    });
  }

  it("NEVER echoes a secret value in the failure message", () => {
    // HARD RULE 3 / user memory `never-inline-secrets-in-tracked-config`: an
    // error text is a log line, so it must not carry the values that ARE present.
    let message = "";
    try {
      resolveGithubE2eSecrets(baseEnv({ [GITHUB_E2E_PAT_VAR]: undefined }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(PEM_ESCAPED);
    expect(message).not.toContain("4338011");
  });
});

// --------------------------------------------------------------- root resolution

describe("resolveRootRepoDir", () => {
  it("prefers SUPAGLOO_ROOT_DIR when set", () => {
    expect(resolveRootRepoDir({ [ROOT_DIR_VAR]: "/somewhere/else" })).toBe(
      "/somewhere/else",
    );
  });

  it("falls back to the established sibling-checkout seam", () => {
    // The identical pattern already in tests/e2e/global-setup.ts.
    expect(resolveRootRepoDir({})).toMatch(/supagloo$/);
  });
});

describe("loadRootE2eHarness", () => {
  it("names the missing file AND SUPAGLOO_ROOT_DIR when the root checkout has no harness", async () => {
    const empty = mkdtempSync(join(tmpdir(), "supagloo-root-missing-"));
    const err = await loadRootE2eHarness({ rootDir: empty }).then(
      () => {
        throw new Error("expected loadRootE2eHarness to reject");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain(E2E_NAMING_MODULE_RELPATH);
    expect(err.message).toContain(ROOT_DIR_VAR);
    expect(err.message).toContain(empty);
  });

  it("throws listing EVERY missing export when root's harness surface drifts", async () => {
    // Anti-drift: the adapter must not fail later with `x is not a function`.
    const importModule = async (href: string) =>
      href.includes("e2e-github-naming")
        ? { E2E_REPO_PREFIX: FAKE_PREFIX } // missing 3 exports
        : {}; // missing everything
    const err = await loadRootE2eHarness({
      rootDir: "/fake",
      importModule,
      requireFilesExist: false,
    }).then(
      () => {
        throw new Error("expected loadRootE2eHarness to reject");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain("buildE2eRepoName");
    expect(err.message).toContain("isE2eRepoName");
    expect(err.message).toContain("discoverInstallation");
    expect(err.message).toContain(E2E_API_MODULE_RELPATH);
  });

  it("re-exports the prefix from root rather than re-typing it (task-62 D1)", async () => {
    const { importModule } = fakeHarness();
    const harness = await loadRootE2eHarness({
      rootDir: "/fake",
      importModule,
      requireFilesExist: false,
    });
    expect(harness.naming.E2E_REPO_PREFIX).toBe(FAKE_PREFIX);
    expect(harness.naming.isE2eRepoName("supagloo-nextjs")).toBe(false);
  });
});

// ------------------------------------------------------------------- the context

describe("resolveGithubE2eContext", () => {
  it("discovers the installation using the PRODUCT JWT signer (db-lib signAppJwt)", async () => {
    const { importModule, calls } = fakeHarness();
    const ctx = await resolveGithubE2eContext({
      env: baseEnv(),
      rootDir: "/fake",
      importModule,
      requireFilesExist: false,
    });

    expect(ctx.installationId).toBe("9000001");
    expect(ctx.owner).toBe("octo-owner");
    expect(ctx.repositorySelection).toBe("all");

    const discover = calls.find((c) => c.name === "discoverInstallation");
    expect(discover).toBeDefined();
    // task-62 D3: api passes db-lib's OWN signer, so a broken product signer fails
    // the harness loudly instead of being masked by a second implementation.
    expect(discover!.args.signJwt).toBe(signAppJwt);
    expect(discover!.args.appId).toBe("4338011");
  });

  it("passes SUPAGLOO_E2E_GITHUB_OWNER through as the owner to match", async () => {
    const { importModule, calls } = fakeHarness();
    const ctx = await resolveGithubE2eContext({
      env: baseEnv({ [GITHUB_E2E_OWNER_VAR]: "some-org" }),
      rootDir: "/fake",
      importModule,
      requireFilesExist: false,
    });
    expect(ctx.owner).toBe("some-org");
    expect(
      calls.find((c) => c.name === "discoverInstallation")!.args.ownerLogin,
    ).toBe("some-org");
  });

  it("omits ownerLogin when the var is unset (root adopts a single installation)", async () => {
    const { importModule, calls } = fakeHarness();
    await resolveGithubE2eContext({
      env: baseEnv(),
      rootDir: "/fake",
      importModule,
      requireFilesExist: false,
    });
    expect(
      calls.find((c) => c.name === "discoverInstallation")!.args.ownerLogin,
    ).toBeUndefined();
  });

  it("is memoised per process — one discovery, one JWT", async () => {
    const { importModule, calls } = fakeHarness();
    const opts = {
      env: baseEnv(),
      rootDir: "/fake",
      importModule,
      requireFilesExist: false,
    };
    const a = await resolveGithubE2eContext(opts);
    const b = await resolveGithubE2eContext(opts);
    expect(b).toBe(a);
    expect(calls.filter((c) => c.name === "discoverInstallation")).toHaveLength(1);
  });

  it("fails on the ENV before touching the root harness at all", async () => {
    // Ordering matters: a missing secret must not surface as a confusing
    // module-resolution error from a sibling checkout.
    let imported = false;
    const importModule = async () => {
      imported = true;
      return {};
    };
    await expect(
      resolveGithubE2eContext({
        env: baseEnv({ [GITHUB_APP_ID_VAR]: undefined }),
        rootDir: "/fake",
        importModule,
        requireFilesExist: false,
      }),
    ).rejects.toThrow(new RegExp(GITHUB_APP_ID_VAR));
    expect(imported).toBe(false);
  });

  it("a discovery failure propagates verbatim (never warn-and-skip)", async () => {
    // plan row 56 item (2): vitest collapses a skipped file's console output, so a
    // "loud skip" is invisible under `npm run test:e2e` — a green lie. The adapter
    // must let root's throw through untouched.
    const boom = new Error(
      `no installation of the Supagloo GitHub App was found — install it at ${GITHUB_APP_INSTALL_URL}`,
    );
    const { importModule } = fakeHarness({
      discover: async () => {
        throw boom;
      },
    });
    await expect(
      resolveGithubE2eContext({
        env: baseEnv(),
        rootDir: "/fake",
        importModule,
        requireFilesExist: false,
      }),
    ).rejects.toThrow(GITHUB_APP_INSTALL_URL);
  });
});

// ------------------------------------------------------------ fixture provisioning

describe("provisionFixtureRepo", () => {
  it("PAT-creates a prefixed private auto_init repo, then gates on BOTH readiness checks", async () => {
    const { importModule, calls, fetchImpl } = fakeHarness();
    const repo = await provisionFixtureRepo("manifest", {
      env: baseEnv(),
      rootDir: "/fake",
      importModule,
      requireFilesExist: false,
      fetchImpl,
    });

    expect(repo.repo).toBe(`${FAKE_PREFIX}manifest-runid42`);
    expect(repo.fullName).toBe(`octo-owner/${FAKE_PREFIX}manifest-runid42`);

    const create = calls.find((c) => c.name === "createFixtureRepo")!;
    // task-62 D6: the PAT creates (the installation has no `administration`), and root
    // owns `private: true` + `auto_init: true` + the stamped description.
    expect(create.args.pat).toBe("ghp_fake_for_unit_test");
    expect(create.args.slug).toBe("manifest");
    expect(create.args.runId).toBe("runid42");
    expect(create.args.spec).toContain("supagloo-nodejs-api");

    // Gate #2 reads GET /installation/repositories, so it MUST be handed an
    // installation token (root's signature), never the PAT and never nothing.
    const visibility = calls.find(
      (c) => c.name === "waitForInstallationVisibility",
    )!;
    expect(visibility.args.token).toBe("ghs_installation_from_product_mint");
    expect(visibility.args.token).not.toBe("ghp_fake_for_unit_test");
    expect(visibility.args.fullName).toBe(
      `octo-owner/${FAKE_PREFIX}manifest-runid42`,
    );

    // The two mandatory gates, IN ORDER, before the repo is handed back (D6/risk 7:
    // `ensureRepoReachable` treats absence as PERMANENT, so a missing gate turns
    // eventual consistency into a non-retryable scaffold failure).
    const order = calls.map((c) => c.name);
    expect(order.indexOf("createFixtureRepo")).toBeLessThan(
      order.indexOf("waitForRepoReady"),
    );
    expect(order.indexOf("waitForRepoReady")).toBeLessThan(
      order.indexOf("waitForInstallationVisibility"),
    );
  });

  it("refuses to proceed if GitHub's created name differs from the gated name", async () => {
    const { importModule, api, naming, fetchImpl } = fakeHarness();
    const real = naming.buildE2eRepoName;
    api.createFixtureRepo = async (_args: any) => ({
      name: "something-else-entirely",
      full_name: "octo-owner/something-else-entirely",
      owner: { login: "octo-owner" },
      default_branch: "main",
      private: true,
    });
    void real;
    await expect(
      provisionFixtureRepo("manifest", {
        env: baseEnv(),
        rootDir: "/fake",
        importModule,
        requireFilesExist: false,
        fetchImpl,
      }),
    ).rejects.toThrow(/mismatch/i);
  });

  it("refuses a slug that would produce a name failing root's own prefix gate", async () => {
    // Defence in depth: the ONE gate is root's `isE2eRepoName`, and the adapter
    // re-checks it at the creation site so a future naming change cannot leak an
    // unprefixed repo into an account holding the user's REAL repos.
    const { importModule, naming } = fakeHarness();
    naming.buildE2eRepoName = () => "totally-not-prefixed";
    await expect(
      provisionFixtureRepo("manifest", {
        env: baseEnv(),
        rootDir: "/fake",
        importModule,
        requireFilesExist: false,
      }),
    ).rejects.toThrow(/prefix/i);
  });
});

describe("seedRepoFileOnBranch", () => {
  it("creates the branch from the base ref BEFORE putting the file", async () => {
    const { importModule, calls } = fakeHarness();
    await seedRepoFileOnBranch({
      owner: "octo-owner",
      repo: `${FAKE_PREFIX}manifest-runid42`,
      branch: "badjson",
      path: "supagloo.project.json",
      content: "{ this is not valid json",
      token: "ghs_installation",
      harnessOptions: {
        env: baseEnv(),
        rootDir: "/fake",
        importModule,
        requireFilesExist: false,
      },
    });
    const order = calls.map((c) => c.name);
    expect(order.indexOf("createRef")).toBeLessThan(order.indexOf("putContents"));
    const put = calls.find((c) => c.name === "putContents")!;
    // The installation token does the content write (D6): it exercises the granted
    // `contents:write` for real, rather than the stronger PAT.
    expect(put.args.token).toBe("ghs_installation");
    expect(put.args.branch).toBe("badjson");
    expect(put.args.content).toBe("{ this is not valid json");
  });

  it("can seed a branch WITHOUT a file (the real 404-on-absent-manifest fixture)", async () => {
    const { importModule, calls } = fakeHarness();
    await seedRepoFileOnBranch({
      owner: "octo-owner",
      repo: "r",
      branch: "absent",
      token: "ghs_installation",
      harnessOptions: {
        env: baseEnv(),
        rootDir: "/fake",
        importModule,
        requireFilesExist: false,
      },
    });
    expect(calls.some((c) => c.name === "createRef")).toBe(true);
    expect(calls.some((c) => c.name === "putContents")).toBe(false);
    // ...and it must PROVE the branch exists, or a wrong ref yields a
    // passing-for-the-wrong-reason 404 (task-62 D11 case 5).
    expect(calls.some((c) => c.name === "listBranches")).toBe(true);
  });
});

// -------------------------------------------------- the real root file, if present

describe("the root harness modules (contract, when the checkout is present)", () => {
  it("the default loader points at the two documented root paths", () => {
    expect(E2E_NAMING_MODULE_RELPATH).toBe(
      "tests/support/e2e-github-naming.mjs",
    );
    expect(E2E_API_MODULE_RELPATH).toBe("tests/support/e2e-github-api.mjs");
  });

  it("a root checkout with only ONE of the two modules still fails on the other", async () => {
    const half = mkdtempSync(join(tmpdir(), "supagloo-root-half-"));
    mkdirSync(join(half, "tests", "support"), { recursive: true });
    writeFileSync(
      join(half, "tests", E2E_NAMING_MODULE_RELPATH.replace("tests/", "")),
      "export const E2E_REPO_PREFIX = 'x';\n",
    );
    const err = await loadRootE2eHarness({ rootDir: half }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain(E2E_API_MODULE_RELPATH);
  });
});

// ------------------------------------- the ONE sanctioned shim (task-62 D13 tier 1)

describe("shimOnlyTheUserAuthorizationTokenExchange", () => {
  const realFetch = (async (input: any) => {
    return new Response(JSON.stringify({ passedThrough: String(input) }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  it("answers the token exchange with the PAT, in GitHub's own envelope shape", async () => {
    const shim = shimOnlyTheUserAuthorizationTokenExchange(realFetch, "ghp_x");
    const res = await shim(USER_AUTHORIZATION_TOKEN_EXCHANGE_URL, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      access_token: "ghp_x",
      token_type: "bearer",
      scope: "repo",
    });
  });

  it("passes EVERY other github.com / api.github.com URL through untouched", async () => {
    const shim = shimOnlyTheUserAuthorizationTokenExchange(realFetch, "ghp_x");
    for (const url of [
      "https://api.github.com/user/repos",
      "https://api.github.com/installation/repositories?per_page=100",
      "https://api.github.com/user/installations/1/repositories/2",
      "https://github.com/login/oauth/authorize?client_id=x",
    ]) {
      const body = (await (await shim(url, { method: "POST" })).json()) as {
        passedThrough: string;
      };
      // Never shim `POST /user/repos`, the scaffold, or the installation listing
      // (preflight §5a item 1) — real GitHub must answer all of them.
      expect(body.passedThrough).toBe(url);
    }
  });

  it("THROWS for any non-GitHub URL rather than silently becoming a general stub", async () => {
    const shim = shimOnlyTheUserAuthorizationTokenExchange(realFetch, "ghp_x");
    await expect(shim("https://evil.example/login/oauth/access_token")).rejects.toThrow(
      /refuses to handle/,
    );
  });

  it("THROWS if the exchange is issued with the wrong method (never masks a client bug)", async () => {
    const shim = shimOnlyTheUserAuthorizationTokenExchange(realFetch, "ghp_x");
    await expect(
      shim(USER_AUTHORIZATION_TOKEN_EXCHANGE_URL, { method: "GET" }),
    ).rejects.toThrow(/POST/);
  });

  it("only ever matches the EXACT exchange URL (no prefix/suffix looseness)", async () => {
    const shim = shimOnlyTheUserAuthorizationTokenExchange(realFetch, "ghp_x");
    const near = await (
      await shim("https://github.com/login/oauth/access_token?x=1", {
        method: "POST",
      })
    ).json();
    // A query-string variant is NOT the exchange this shim owns; it must pass through
    // to real GitHub rather than be answered with a PAT.
    expect(near).toEqual({
      passedThrough: "https://github.com/login/oauth/access_token?x=1",
    });
  });
});

describe("resolveGithubOauthClientCreds", () => {
  it("returns both OAuth client credentials", () => {
    expect(
      resolveGithubOauthClientCreds({
        [GITHUB_APP_CLIENT_ID_VAR]: "Iv1.real",
        [GITHUB_APP_CLIENT_SECRET_VAR]: "s3cret",
      }),
    ).toEqual({ clientId: "Iv1.real", clientSecret: "s3cret" });
  });

  it("is SEPARATE from the four core vars, so other specs stay runnable without it", () => {
    expect([...GITHUB_E2E_ENV_VARS]).not.toContain(GITHUB_APP_CLIENT_ID_VAR);
    expect([...GITHUB_E2E_ENV_VARS]).not.toContain(GITHUB_APP_CLIENT_SECRET_VAR);
  });

  for (const missing of [GITHUB_APP_CLIENT_ID_VAR, GITHUB_APP_CLIENT_SECRET_VAR]) {
    it(`throws naming ${missing} and the root .env`, () => {
      const env: Record<string, string | undefined> = {
        [GITHUB_APP_CLIENT_ID_VAR]: "Iv1.real",
        [GITHUB_APP_CLIENT_SECRET_VAR]: "s3cret",
      };
      env[missing] = "";
      expect(() => resolveGithubOauthClientCreds(env)).toThrow(
        new RegExp(`${missing}[\\s\\S]*\\.env`),
      );
    });
  }
});
