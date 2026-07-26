import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mintInstallationToken, signAppJwt } from "@supagloo/database-lib";

/**
 * Real-GitHub e2e ADAPTER for the api (task-62 D4).
 *
 * The api e2e no longer talks to a github-stub: every GitHub-touching spec reaches
 * real `api.github.com` / `github.com` (task-62 half (A), design-delta §11). This
 * module is the api's thin seam onto the SHARED harness that lives in the ROOT repo:
 *
 *   root `tests/support/e2e-github-naming.mjs`  — the ONE authored
 *       throwaway-repo-name prefix literal (task-62 D1). Nothing here re-types it: the
 *       cleanup script's hard gate and the specs' repo names must be the SAME code, or
 *       a naming change silently orphans throwaway repos in an account that also holds
 *       the user's REAL repositories.
 *   root `tests/support/e2e-github-api.mjs`     — the ONE network implementation
 *       (task-62 D3): installation discovery, fixture-repo creation, the two
 *       eventual-consistency gates, ref/contents seeding, and the assertion readers,
 *       all with Retry-After-aware backoff.
 *
 * Both are resolved through the seam this repo already uses for the root checkout
 * (`SUPAGLOO_ROOT_DIR ?? <api>/../supagloo`, identical to
 * `tests/e2e/global-setup.ts`) and dynamic-imported as plain ESM — no build step,
 * no npm dependency between the repos.
 *
 * WHY DISCOVERY IS NOT IMPLEMENTED HERE (deliberate, task-62 D3): a second
 * implementation of the App-JWT → `GET /app/installations` walk is precisely how row
 * 62 item (c)'s PEM bug survived — two normalisation code paths, only one of them
 * correct. api hands root's `discoverInstallation` the PRODUCT signer (db-lib's
 * `signAppJwt`, the same function `github-app-client.ts` uses), so a broken product
 * signer fails the harness LOUDLY instead of being masked. Root's own
 * `tests/unit/e2e-github-api.test.ts` owns the assertions about discovery's five
 * fail-fast throws; this module's unit test owns the api-side contract.
 *
 * WHAT *IS* LOCAL: the env fail-fast. It must fire BEFORE any sibling-checkout module
 * resolution, so a missing credential reads as "set GITHUB_E2E_PAT_TOKEN in
 * <root>/.env" rather than as a confusing module-not-found from another repo.
 *
 * TEST-ONLY. Excluded from the shipped `dist/` by `tsconfig.build.json` (`src/testing/**`),
 * exactly like `seed-connections.ts`, and never imported by `src/app.ts`.
 */

// ---------------------------------------------------------------- env var names

export const GITHUB_APP_ID_VAR = "GITHUB_APP_ID";
export const GITHUB_APP_SLUG_VAR = "GITHUB_APP_SLUG";
export const GITHUB_APP_PRIVATE_KEY_VAR = "GITHUB_APP_PRIVATE_KEY";
/** Classic PAT (`repo`) used ONLY to create/archive fixture repos — the installation
 *  grants no `administration`, so an installation token structurally cannot (verified
 *  live, preflight §1). HOST-SIDE ONLY: it must never enter a container or a render
 *  child process. */
export const GITHUB_E2E_PAT_VAR = "GITHUB_E2E_PAT_TOKEN";
/** Optional. Which account's installation to adopt when the App has more than one. */
export const GITHUB_E2E_OWNER_VAR = "SUPAGLOO_E2E_GITHUB_OWNER";
export const ROOT_DIR_VAR = "SUPAGLOO_ROOT_DIR";

/** The four REQUIRED vars, in a stable order — single source of truth for the
 *  fail-fast and for `.env.example` consistency (mirrors `seed-connections.ts`). */
export const GITHUB_E2E_ENV_VARS = [
  GITHUB_APP_ID_VAR,
  GITHUB_APP_SLUG_VAR,
  GITHUB_APP_PRIVATE_KEY_VAR,
  GITHUB_E2E_PAT_VAR,
] as const;

/** Named in the fail-fast text so a zero-installation account is a 10-second fix
 *  instead of the opaque `POST /app/installations/42/access_tokens → 404` that cost
 *  row 62 item (d) an entire debugging cycle. */
export const GITHUB_APP_INSTALL_URL =
  "https://github.com/apps/supagloo/installations/new";

export const E2E_NAMING_MODULE_RELPATH = "tests/support/e2e-github-naming.mjs";
export const E2E_API_MODULE_RELPATH = "tests/support/e2e-github-api.mjs";

const REQUIRED_NAMING_EXPORTS = [
  "E2E_REPO_PREFIX",
  "E2E_RUN_ID",
  "buildE2eRepoName",
  "isE2eRepoName",
] as const;

const REQUIRED_API_EXPORTS = [
  "discoverInstallation",
  "createFixtureRepo",
  "waitForRepoReady",
  "waitForInstallationVisibility",
  "createRef",
  "putContents",
  "listBranches",
] as const;

// -------------------------------------------------------------------- env types

type EnvSource = Record<string, string | undefined>;

export interface GithubE2eSecrets {
  appId: string;
  appSlug: string;
  /** PKCS#1/PKCS#8 PEM, possibly in the single-line escaped-`\n` env form. Passed
   *  through UNCHANGED: normalisation is db-lib's job (`normalizePemNewlines`). */
  privateKey: string;
  pat: string;
}

/**
 * Resolve the four required GitHub e2e secrets from the environment, failing FAST with
 * an actionable message that names the var, the root `.env` it belongs in, and
 * `.env.example`. A blank/whitespace value counts as missing.
 *
 * This THROWS — it never warns and skips. plan row 56 item (2): vitest's default
 * reporter collapses a skipped file's console output, so a `console.warn` + skip is
 * invisible under `npm run test:e2e` and produces a green lie.
 *
 * The message never contains a VALUE (HARD RULE 3).
 */
export function resolveGithubE2eSecrets(
  env: EnvSource = process.env,
): GithubE2eSecrets {
  const rootDir = resolveRootRepoDir(env);
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `Real-GitHub e2e requires the environment variable ${name}, but it is ` +
          `missing or blank. Set it in the untracked root .env ` +
          `(${join(rootDir, ".env")}) — see .env.example for the documented ` +
          `variable names (values never live in tracked config). The api e2e loads ` +
          `that file automatically via tests/e2e/load-root-env.ts; you can also ` +
          `override any single var inline, e.g. \`${name}=… npm run test:e2e\`. ` +
          `This suite must NEVER skip on a missing credential — a green suite that ` +
          `silently skipped its GitHub coverage is a lie (design-delta §10.8).`,
      );
    }
    return value;
  };
  return {
    appId: read(GITHUB_APP_ID_VAR),
    appSlug: read(GITHUB_APP_SLUG_VAR),
    privateKey: read(GITHUB_APP_PRIVATE_KEY_VAR),
    pat: read(GITHUB_E2E_PAT_VAR),
  };
}

/**
 * The root Supagloo checkout: `SUPAGLOO_ROOT_DIR` when set, else the sibling-directory
 * seam `tests/e2e/global-setup.ts` already uses.
 *
 * The base is `process.cwd()` rather than `import.meta.url` ON PURPOSE: this repo
 * compiles `src/` to **CommonJS** (`tsconfig.json` `module: node16`), so `import.meta`
 * is a typecheck error in any file under `src/` — even one the build excludes. vitest
 * always runs with the package root as cwd, and `SUPAGLOO_ROOT_DIR` is the documented
 * override for every other layout.
 */
export function resolveRootRepoDir(env: EnvSource = process.env): string {
  return env[ROOT_DIR_VAR] ?? resolve(process.cwd(), "..", "supagloo");
}

// ------------------------------------------------------------- harness loading

export interface RootNamingModule {
  E2E_REPO_PREFIX: string;
  E2E_RUN_ID: string;
  buildE2eRepoName(slug: string, runId: string): string;
  isE2eRepoName(name: string): boolean;
}

/**
 * The subset of root's `tests/support/e2e-github-api.mjs` the api adapter uses, typed to
 * root's ACTUAL signatures. Kept deliberately narrow: every entry here is a cross-repo
 * coupling, and `loadRootE2eHarness` validates each name exists at load time so a rename
 * in root fails once, loudly, instead of as `x is not a function` mid-spec.
 */
export interface RootApiModule {
  /** NB: returns `ownerLogin` (not `owner`) plus `accountType`. */
  discoverInstallation(args: {
    appId: string;
    appSlug?: string;
    privateKey: string;
    ownerLogin?: string;
    signJwt?: (a: {
      appId: string;
      privateKey: string;
    }) => string | Promise<string>;
  }): Promise<{
    installationId: string;
    ownerLogin: string;
    accountType?: string;
    repositorySelection?: string;
  }>;
  /** Builds the prefixed name ITSELF from `slug`+`runId` and returns GitHub's RAW
   *  `POST /user/repos` body (`full_name`, `owner.login`, `default_branch`, …). */
  createFixtureRepo(args: {
    pat: string;
    slug: string;
    runId?: string;
    spec?: string;
  }): Promise<{
    name: string;
    full_name: string;
    owner: { login: string };
    default_branch: string;
    private: boolean;
  }>;
  waitForRepoReady(args: {
    pat: string;
    owner: string;
    repo: string;
    branch?: string;
  }): Promise<unknown>;
  /** Takes an INSTALLATION TOKEN — it reads `GET /installation/repositories`. */
  waitForInstallationVisibility(args: {
    token: string;
    fullName: string;
  }): Promise<unknown>;
  createRef(args: {
    token: string;
    owner: string;
    repo: string;
    branch: string;
    fromBranch: string;
  }): Promise<unknown>;
  putContents(args: {
    token: string;
    owner: string;
    repo: string;
    branch: string;
    path: string;
    content: string;
  }): Promise<unknown>;
  listBranches(args: {
    token: string;
    owner: string;
    repo: string;
  }): Promise<{ name: string }[]>;
  [extra: string]: unknown;
}

export interface RootE2eHarness {
  rootDir: string;
  naming: RootNamingModule;
  api: RootApiModule;
}

export type HarnessImporter = (href: string) => Promise<unknown>;

export interface HarnessOptions {
  env?: EnvSource;
  rootDir?: string;
  /** Injectable for unit tests; defaults to a real dynamic `import()`. */
  importModule?: HarnessImporter;
  /** Unit tests set this false to skip the on-disk pre-check. */
  requireFilesExist?: boolean;
  /**
   * Injectable `fetch` for the ONE network call this adapter makes itself (the
   * product-code installation-token mint). REQUIRED by the unit lane: without it a
   * `provisionFixtureRepo` unit test would really POST to api.github.com, and HARD
   * RULE 5 / design-delta §10.6 keep the unit suite egress-free. The e2e lane leaves it
   * undefined and gets the global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

function missingExports(
  mod: unknown,
  required: readonly string[],
): string[] {
  const record = (mod ?? {}) as Record<string, unknown>;
  return required.filter((name) => record[name] === undefined);
}

/**
 * Resolve + dynamic-import root's two harness modules, validating their export
 * surface up front so a drift fails ONCE, loudly, naming every missing export —
 * rather than four minutes later as `x is not a function` inside a spec.
 */
export async function loadRootE2eHarness(
  opts: HarnessOptions = {},
): Promise<RootE2eHarness> {
  const env = opts.env ?? process.env;
  const rootDir = opts.rootDir ?? resolveRootRepoDir(env);
  const importModule: HarnessImporter =
    opts.importModule ?? ((href) => import(/* @vite-ignore */ href));
  const check = opts.requireFilesExist ?? opts.importModule === undefined;

  const paths = {
    naming: join(rootDir, E2E_NAMING_MODULE_RELPATH),
    api: join(rootDir, E2E_API_MODULE_RELPATH),
  };

  if (check) {
    for (const [key, relPath] of [
      ["naming", E2E_NAMING_MODULE_RELPATH],
      ["api", E2E_API_MODULE_RELPATH],
    ] as const) {
      if (!existsSync(paths[key])) {
        throw new Error(
          `The api real-GitHub e2e harness needs the SHARED module ${relPath} from ` +
            `the root Supagloo repo, but it was not found at ${paths[key]}. The root ` +
            `checkout was resolved to ${rootDir} — set ${ROOT_DIR_VAR} if the root ` +
            `repo lives elsewhere. That file is the single source of the ` +
            `throwaway-repo naming gate and of the real-GitHub network harness ` +
            `(task-62 D1/D3); the api deliberately does NOT re-implement either, so ` +
            `there is no fallback.`,
        );
      }
    }
  }

  const namingMod = await importModule(pathToFileURL(paths.naming).href);
  const apiMod = await importModule(pathToFileURL(paths.api).href);

  const problems: string[] = [];
  const namingMissing = missingExports(namingMod, REQUIRED_NAMING_EXPORTS);
  if (namingMissing.length > 0) {
    problems.push(
      `${E2E_NAMING_MODULE_RELPATH} is missing: ${namingMissing.join(", ")}`,
    );
  }
  const apiMissing = missingExports(apiMod, REQUIRED_API_EXPORTS);
  if (apiMissing.length > 0) {
    problems.push(`${E2E_API_MODULE_RELPATH} is missing: ${apiMissing.join(", ")}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `The root real-GitHub e2e harness does not expose the surface the api adapter ` +
        `requires (task-62 D1/D3). ${problems.join("; ")}. Either the root repo is on ` +
        `an older revision than this api checkout, or an export was renamed — fix it ` +
        `in the root repo rather than re-implementing it here.`,
    );
  }

  return {
    rootDir,
    naming: namingMod as RootNamingModule,
    api: apiMod as RootApiModule,
  };
}

// ------------------------------------------------------------------- the context

export interface GithubE2eContext extends GithubE2eSecrets {
  /** Discovered at runtime — NEVER hardcoded. Installation ids change on reinstall. */
  installationId: string;
  /** The account login the installation belongs to (replaces the fabricated `acme`). */
  owner: string;
  repositorySelection: string;
  /** One id per process, shared by every fixture repo this run creates. */
  runId: string;
  harness: RootE2eHarness;
}

let memoisedContext: Promise<GithubE2eContext> | null = null;

/** Unit-test hook: drop the per-process memo so each case starts clean. */
export function __resetGithubE2eMemoForTests(): void {
  memoisedContext = null;
}

/**
 * Resolve everything the api e2e needs to talk to real GitHub, ONCE per process
 * (one App JWT, one `GET /app/installations`, ~200 ms).
 *
 * Order is deliberate: secrets first (a missing credential must not surface as a
 * module-resolution error), then the root harness, then discovery.
 */
export async function resolveGithubE2eContext(
  opts: HarnessOptions = {},
): Promise<GithubE2eContext> {
  if (memoisedContext) return memoisedContext;
  const env = opts.env ?? process.env;

  // Fail-fast BEFORE any dynamic import — see the ordering note above.
  const secrets = resolveGithubE2eSecrets(env);

  memoisedContext = (async () => {
    const harness = await loadRootE2eHarness(opts);
    const ownerLogin = env[GITHUB_E2E_OWNER_VAR]?.trim() || undefined;
    // task-62 D3/D5: hand root the PRODUCT signer. If db-lib's signAppJwt regresses
    // (row 62 item (c)'s bug class), the harness fails loudly instead of a private
    // second implementation quietly papering over it.
    const installation = await harness.api.discoverInstallation({
      appId: secrets.appId,
      appSlug: secrets.appSlug,
      privateKey: secrets.privateKey,
      ownerLogin,
      signJwt: signAppJwt,
    });
    return {
      ...secrets,
      installationId: installation.installationId,
      // root returns `ownerLogin`; the api surfaces it as `owner` because that is the
      // column name (`GithubConnection.githubLogin` ← this value) and the Project
      // field (`repoOwner`) it feeds.
      owner: installation.ownerLogin,
      repositorySelection: installation.repositorySelection ?? "all",
      runId: harness.naming.E2E_RUN_ID,
      harness,
    };
  })();

  try {
    return await memoisedContext;
  } catch (err) {
    // Never cache a failure: a transient GitHub 5xx must not poison the whole file.
    memoisedContext = null;
    throw err;
  }
}

// -------------------------------------------------------- installation tokens

/**
 * Mint an installation token with the PRODUCT primitive (db-lib's
 * `mintInstallationToken`, the same one `github-app-client.ts` uses). Fixture SEEDING
 * uses this rather than the PAT so the write exercises the installation's granted
 * `contents:write` for real (task-62 D6): a seed that succeeds is itself a scoping
 * proof, and a PAT — a strictly stronger credential than production ever holds —
 * could green-light a permission the product does not have.
 */
export async function mintE2eInstallationToken(
  opts: HarnessOptions & { apiBaseUrl?: string } = {},
): Promise<string> {
  const ctx = await resolveGithubE2eContext(opts);
  const { token } = await mintInstallationToken({
    appId: ctx.appId,
    privateKey: ctx.privateKey,
    installationId: ctx.installationId,
    apiBaseUrl: opts.apiBaseUrl ?? githubApiBaseUrl(opts.env),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return token;
}

/** The REST host the api e2e talks to. Real by DEFAULT — the task-62 delta is
 *  REMOVING the test-side override, not adding config. */
export function githubApiBaseUrl(env: EnvSource = process.env): string {
  return env.GITHUB_API_BASE_URL ?? "https://api.github.com";
}

/** The PUBLIC user-authorization host — what a browser opens. Real by default, same
 *  reasoning. */
export function githubOauthBaseUrl(env: EnvSource = process.env): string {
  return env.GITHUB_OAUTH_BASE_URL ?? "https://github.com";
}

/**
 * The INTERNAL user-authorization host — the one `exchangeCode` POSTs to (plan row
 * 66). Defaults to the public one, and that default is LOAD-BEARING for this repo's
 * own e2e lane, not a convenience:
 *
 * `shimOnlyTheUserAuthorizationTokenExchange` below matches by EXACT string equality
 * against `https://github.com/login/oauth/access_token` and THROWS on any other URL —
 * deliberately, so it can never rot into a general-purpose stub. The api e2e runs the
 * client IN-PROCESS with that shim as its `fetchImpl`, so the internal base must keep
 * resolving to the public literal here. Only the CONTAINERISED api (whose exchange
 * has no in-process seam at all) ever sets `GITHUB_OAUTH_INTERNAL_BASE_URL`, and it
 * points at itself over the Compose network.
 */
export function githubOauthInternalBaseUrl(env: EnvSource = process.env): string {
  return env.GITHUB_OAUTH_INTERNAL_BASE_URL ?? githubOauthBaseUrl(env);
}

// ---------------------------------------------------------- fixture provisioning

export interface FixtureRepo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
}

/**
 * Create ONE throwaway repo for a spec (task-62 D6/D7).
 *
 * - The **PAT** creates it: the installation grants no `administration` (live-verified),
 *   and `POST /user/repos` is user-scoped regardless.
 * - `private: true` — throwaway artifacts land in a personal account that also holds
 *   the user's REAL repositories.
 * - **`auto_init: true` is LOAD-BEARING, not cosmetic.** `scaffold-project.ts` opens
 *   its base PR with `base: "main"`; a commit-less repo has no `main` and real GitHub
 *   422s. Anyone "simplifying" this breaks scaffold, commit, publish and the render
 *   lane at once (task-62 risk 5).
 * - Then BOTH eventual-consistency gates, in order: a just-created repo can 404
 *   briefly, and can be briefly absent from `GET /installation/repositories` — which
 *   `ensureRepoReachable` treats as a PERMANENT `RepoUnreachableError`, turning a race
 *   into a non-retryable scaffold failure (task-62 risk 7).
 *
 * There is deliberately **NO teardown** — not on success, not on failure. Reclamation
 * is the root repo's interactive, archive-only `npm run cleanup:github-e2e`
 * (preflight §5): you almost always need the repo to debug a red run, and an automated
 * mutation in an account holding real repos is unacceptable.
 *
 * A repo-name 422 is FATAL and never retried: with per-run ids a collision means a
 * bug, and a retry loop would mask it.
 */
export async function provisionFixtureRepo(
  slug: string,
  opts: HarnessOptions & { spec?: string } = {},
): Promise<FixtureRepo> {
  const ctx = await resolveGithubE2eContext(opts);
  const { naming, api } = ctx.harness;

  const name = naming.buildE2eRepoName(slug, ctx.runId);
  // Re-check root's OWN gate at the creation site. Defence in depth: the gate is a
  // code invariant, not a naming side effect, because the blast radius is a personal
  // account full of real repositories.
  if (!naming.isE2eRepoName(name)) {
    throw new Error(
      `Refusing to create the GitHub repo "${name}": it does not satisfy the ` +
        `throwaway-repo prefix gate exported by root's ${E2E_NAMING_MODULE_RELPATH}. ` +
        `Fixture repos are created in an account that also holds real ` +
        `repositories, and the cleanup script will only ever archive prefixed names ` +
        `— an unprefixed fixture would be unreclaimable. Fix buildE2eRepoName/` +
        `isE2eRepoName in the root repo (task-62 D1).`,
    );
  }

  // root's `createFixtureRepo` derives the name from slug+runId itself (with
  // `private: true` + `auto_init: true` + a stamped description) and returns GitHub's
  // RAW repo body.
  const body = await api.createFixtureRepo({
    pat: ctx.pat,
    slug,
    runId: ctx.runId,
    spec: opts.spec ?? "supagloo-nodejs-api",
  });

  const created: FixtureRepo = {
    owner: body.owner.login,
    repo: body.name,
    fullName: body.full_name,
    defaultBranch: body.default_branch,
  };

  // Defence in depth: the name we GATED must be the name GitHub actually created. If
  // root's builder and our gate ever disagree, stop here — a repo whose name the
  // cleanup script will not match is unreclaimable, in an account holding real repos.
  if (created.repo !== name) {
    throw new Error(
      `Fixture repo name mismatch: the prefix gate approved "${name}" but GitHub ` +
        `created "${created.repo}". Refusing to proceed — root's buildE2eRepoName and ` +
        `createFixtureRepo must agree (task-62 D1).`,
    );
  }
  if (!naming.isE2eRepoName(created.repo)) {
    throw new Error(
      `GitHub created "${created.repo}", which does NOT satisfy root's throwaway-repo ` +
        `prefix gate. This must never happen; treat it as a naming-module bug.`,
    );
  }

  await api.waitForRepoReady({
    pat: ctx.pat,
    owner: created.owner,
    repo: created.repo,
    branch: created.defaultBranch,
  });
  // Gate #2 reads `GET /installation/repositories`, so it needs an INSTALLATION token —
  // minted here by the PRODUCT primitive (db-lib `mintInstallationToken`), not the PAT.
  await api.waitForInstallationVisibility({
    token: await mintE2eInstallationToken(opts),
    fullName: created.fullName,
  });

  return created;
}

/**
 * Seed one real branch (cut from the repo's default branch) and, optionally, one real
 * file on it with the INSTALLATION token — the replacement for the retired stub's
 * `POST /__admin/contents` (task-62 D11).
 *
 * Omitting `path`/`content` produces a branch with NO manifest, which is how the
 * "404 on an absent manifest" case becomes a REAL GitHub 404. In that case the branch
 * is verified to exist first: without that check a wrong ref yields a 404 too, and the
 * test would pass for entirely the wrong reason.
 */
export async function seedRepoFileOnBranch(args: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  path?: string;
  content?: string;
  fromBranch?: string;
  harnessOptions?: HarnessOptions;
}): Promise<void> {
  const harness = await loadRootE2eHarness(args.harnessOptions ?? {});
  const { api } = harness;
  const fromBranch = args.fromBranch ?? "main";

  await api.createRef({
    token: args.token,
    owner: args.owner,
    repo: args.repo,
    branch: args.branch,
    fromBranch,
  });

  if (args.path !== undefined && args.content !== undefined) {
    await api.putContents({
      token: args.token,
      owner: args.owner,
      repo: args.repo,
      branch: args.branch,
      path: args.path,
      content: args.content,
    });
    return;
  }

  // No file: PROVE the branch exists, or the 404 under test is meaningless.
  const branches = await api.listBranches({
    token: args.token,
    owner: args.owner,
    repo: args.repo,
  });
  if (!branches.some((b) => b.name === args.branch)) {
    throw new Error(
      `Fixture branch "${args.branch}" was not found on ` +
        `${args.owner}/${args.repo} after createRef. A manifest-absent test on a ` +
        `NON-EXISTENT ref would 404 for the wrong reason, so this is fatal. ` +
        `Branches seen: ${branches.map((b) => b.name).join(", ") || "(none)"}.`,
    );
  }
}

// -------------------------------------------- the ONE sanctioned e2e GitHub shim

export const GITHUB_APP_CLIENT_ID_VAR = "GITHUB_APP_CLIENT_ID";
export const GITHUB_APP_CLIENT_SECRET_VAR = "GITHUB_APP_CLIENT_SECRET";

export interface GithubOauthClientCreds {
  clientId: string;
  clientSecret: string;
}

/**
 * The App's user-to-server OAuth client id/secret. Required ONLY by the
 * create-new-repo hop (`repo-provisioning.e2e.ts`), which is why it is separate from
 * {@link GITHUB_E2E_ENV_VARS} — no other api e2e should be unrunnable because of it.
 */
export function resolveGithubOauthClientCreds(
  env: EnvSource = process.env,
): GithubOauthClientCreds {
  const rootDir = resolveRootRepoDir(env);
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `The create-new-repo e2e requires ${name} (the GitHub App's user-to-server ` +
          `OAuth client credential), but it is missing or blank. Set it in the ` +
          `untracked root .env (${join(rootDir, ".env")}); see .env.example for the ` +
          `variable names. This suite must never skip on a missing credential.`,
      );
    }
    return value;
  };
  return {
    clientId: read(GITHUB_APP_CLIENT_ID_VAR),
    clientSecret: read(GITHUB_APP_CLIENT_SECRET_VAR),
  };
}

/** The exact — and ONLY — URL this shim is permitted to answer. */
export const USER_AUTHORIZATION_TOKEN_EXCHANGE_URL =
  "https://github.com/login/oauth/access_token";

/**
 * SHIM EXACTLY ONE HOP: `POST https://github.com/login/oauth/access_token`.
 *
 * The create-new-repo path (wireframe 12a step 1) runs:
 *   1. browser → github.com to approve the App
 *   2. a HUMAN clicks "Authorize"                 ← unautomatable headlessly
 *   3. GitHub hands our App a short-lived `code`
 *   4. our api trades the code for a user token   ← THIS, and only this, is shimmed
 *   5. our api creates the repo: POST /user/repos ← REAL
 *   6. scaffoldProjectWorkflow clones/commits/PRs ← REAL
 *
 * Only steps 2–3 are impossible in a headless spec, and a real `code` cannot be
 * manufactured (real GitHub answers `bad_verification_code`; the retired stub accepted
 * any non-empty string, which is why `code=e2e-create-repo-code` used to "work"). So
 * step 4 returns `GITHUB_E2E_PAT_TOKEN` in place of the OAuth-issued user token.
 *
 * This is legitimate under design-delta §10.2 (1448-1452), which sanctions shimming
 * "interactive browser logins … only that interactive hop" with everything after it
 * real — the same exception already used for YouVersion sign-in and OpenRouter PKCE.
 * The substitution is honest rather than a cheat because BOTH credentials are
 * user-scoped credentials for the SAME account, so `POST /user/repos` cannot
 * distinguish them; the only thing faked is the token's PROVENANCE.
 *
 * PROVES: our repo-creation code and the whole downstream chain work against real
 * GitHub — real name-collision 422s, real permission behaviour, real eventual
 * consistency.
 * DOES NOT PROVE: the code-for-token exchange itself (redirect round-trip, `state`,
 * `bad_verification_code`). That is covered at unit level in
 * `src/connections/github-user-auth-client.test.ts`, deliberately and explicitly —
 * do not let anyone read this shim as e2e coverage of the exchange.
 *
 * The guard rail that keeps it from rotting into general-purpose stubbing: any other
 * URL **throws**. It can never quietly grow to cover `POST /user/repos`, the scaffold,
 * or `GET /installation/repositories` (preflight §5a item 1). Never reintroduce a stub
 * HTTP server for this (§10.7 1626-1629, §10.9 1663-1666).
 */
export function shimOnlyTheUserAuthorizationTokenExchange(
  realFetch: typeof fetch,
  pat: string,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url === USER_AUTHORIZATION_TOKEN_EXCHANGE_URL) {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "POST") {
        throw new Error(
          `shimOnlyTheUserAuthorizationTokenExchange: the token exchange is a POST, ` +
            `but the client issued ${method} ${url}. Refusing to answer — the shim ` +
            `must not mask a client bug.`,
        );
      }
      // Real GitHub's success envelope, shape-for-shape.
      return new Response(
        JSON.stringify({
          access_token: pat,
          token_type: "bearer",
          scope: "repo",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // github.com / api.github.com URLs other than the exchange go through UNTOUCHED —
    // that is the whole point: `POST /user/repos` really creates a repo.
    if (
      url.startsWith("https://api.github.com/") ||
      url.startsWith("https://github.com/")
    ) {
      return realFetch(input as never, init);
    }

    throw new Error(
      `shimOnlyTheUserAuthorizationTokenExchange refuses to handle ${url}. It exists ` +
        `for exactly ONE GitHub-hosted consent hop (` +
        `${USER_AUTHORIZATION_TOKEN_EXCHANGE_URL}) and must never become a ` +
        `general-purpose stub (preflight §5a item 1). If a spec needs this URL, it is ` +
        `pointing somewhere it should not be.`,
    );
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------- connection seeding

/**
 * Write the user's `GithubConnection` row with the DISCOVERED installation id, login
 * and `repositorySelection` — never the fabricated `installationId: "42"` /
 * `githubLogin: "acme"` the stub era used. Row 62 item (d) was exactly this: real
 * GitHub correctly 404s `POST /app/installations/42/access_tokens`.
 */
export async function seedGithubConnection(
  prisma: {
    githubConnection: {
      create(args: { data: Record<string, unknown> }): Promise<unknown>;
    };
  },
  userId: string,
  opts: HarnessOptions = {},
): Promise<GithubE2eContext> {
  const ctx = await resolveGithubE2eContext(opts);
  await prisma.githubConnection.create({
    data: {
      userId,
      githubLogin: ctx.owner,
      installationId: ctx.installationId,
      repositorySelection: ctx.repositorySelection,
      status: "connected",
      connectedAt: new Date(),
    },
  });
  return ctx;
}
