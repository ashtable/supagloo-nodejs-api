import type {
  CreateProjectRequest,
  CreateRepoRequest,
  PrismaClient,
} from "@supagloo/database-lib";
import { GithubNotConnectedError } from "../connections/errors";
import {
  GithubCreateRepoError,
  type GithubUserAuthClient,
} from "../connections/github-user-auth-client";
import type { GithubAppClient } from "../connections/github-app-client";
import {
  RepoCreationError,
  RepoNotVisibleError,
} from "./repo-provisioning-errors";
import type { ProjectScripture } from "../jobs/project-scripture";

/** The create-project+scaffold delegate (task-18 `ProjectJobsService.createProjectWithScaffold`),
 *  injected as a seam so this service depends only on the create CONTRACT, not the
 *  whole ProjectJobsService class.
 *
 *  Feature 2: `scripture` is a forward declaration — db-lib's request schemas carry it
 *  from the release step, and this intersection collapses at the bump. */
export type CreateProjectDelegate = (
  userId: string,
  req: CreateProjectRequest & { scripture?: ProjectScripture },
) => Promise<{ projectId: string; jobId: string }>;

/** Tuning for the installation-visibility gate (DR1). Every value has a default; this
 *  exists so a test can shrink the window and an operator can widen it. */
export interface InstallationVisibilityOptions {
  /** Total budget for the repo to appear. Deliberately the SAME 60 s the e2e harness's
   *  `waitForInstallationVisibility` uses: if the product's gate were tighter than the
   *  test gate, every e2e would pass while production raced. */
  timeoutMs?: number;
  /** Delay before the SECOND probe. The first probe is immediate — see the gate. */
  initialDelayMs?: number;
  /** Cap on the doubling delay (harness parity). */
  maxDelayMs?: number;
}

/**
 * The gate's listing, as a seam: `owner/name` for every repo the installation can reach.
 *
 * ── WHICH ENDPOINT, AND WHY IT CHANGED (2026-07-31) ─────────────────────────────────
 * It reads **`GET /installation/repositories` with an installation token this service's
 * GitHub App client mints itself** — see {@link RepoProvisioningServiceOptions.appClient}.
 *
 * Until this change it read `GET /user/installations/:id/repositories` with the
 * short-lived USER token, which was available for free but was the wrong question in two
 * ways:
 *
 *  1. **Fidelity.** The thing this gate exists to predict is dbos's `ensureRepoReachable`
 *     (`scaffold-project/github-rest.ts`), which walks `GET /installation/repositories`
 *     and treats absence as a PERMANENT failure. Probing the USER's view to predict the
 *     INSTALLATION's view is indirect: two endpoints, two caches, no guarantee they agree
 *     at any instant. Probing the installation's own view asks the question that is
 *     actually being answered later.
 *  2. **Testability.** GitHub serves `/user/installations/:id/repositories` to GitHub App
 *     **user-to-server tokens only**, answering anything else with
 *     `403 "You must authenticate with an access token authorized to a GitHub App…"`
 *     (verified live, 2026-07-31, against BOTH e2e PATs). Production's real OAuth hop
 *     mints a user-to-server token so the old read worked there — but the browser e2e
 *     (`E-RNP1b`) fakes the token's PROVENANCE with a classic PAT (design-delta §10.2),
 *     so the gate could never pass in the harness, deterministically. A product gate that
 *     is unreachable from the only lane that drives it end to end is untested by
 *     construction.
 *
 * The installation listing has neither problem: the app client mints its own token from
 * the App's private key, so it is the same credential in production and in every lane.
 *
 * Note the argument shape: **no `token`**. That is deliberate and load-bearing — the
 * user token is now scoped to `provisionRepo` and cannot reach the gate at all, so this
 * seam cannot be quietly repointed back at a user-scoped endpoint.
 */
export type InstallationRepoLister = (args: {
  installationId: string;
}) => Promise<string[]>;

/**
 * The production lister: dbos's own view, through the App client.
 *
 * Exported (rather than inlined at the construction site) so the endpoint choice is a
 * named, unit-tested thing instead of a lambda in `server.ts`'s 300-line `main()`, which
 * nothing can reach without booting a process.
 *
 * `deriveEmptinessFor` is deliberately NOT passed: it would fan an extra commits probe
 * out over every `size === 0` repo in the installation — measured at 55 for the live
 * account — on a request a browser is already waiting on, to compute a field this gate
 * does not read.
 *
 * COST, stated rather than discovered later: each probe is one token mint plus one
 * listing GET per page (measured 2026-07-26: 582 repos ⇒ 6 pages ⇒ 7 requests). The
 * previous user-token listing paginated identically, so the delta is the mint — and the
 * COMMON case is a single probe, because the gate reads before it ever sleeps. The App
 * client's "mint fresh per call, never store" invariant is deliberately not bent to share
 * a token across probes: a bounded loop that runs a handful of times on one non-idempotent
 * hop is not where that invariant should be spent.
 */
export function installationTokenRepoLister(
  appClient: Pick<GithubAppClient, "listInstallationRepos">,
): InstallationRepoLister {
  return async ({ installationId }) => {
    const repos = await appClient.listInstallationRepos({ installationId });
    return repos.map((r) => r.fullName);
  };
}

const VISIBILITY_DEFAULTS = {
  timeoutMs: 60_000,
  initialDelayMs: 1_000,
  maxDelayMs: 5_000,
} as const;

export interface RepoProvisioningServiceOptions {
  prisma: PrismaClient;
  userAuthClient: GithubUserAuthClient;
  /**
   * The GitHub App client the visibility gate reads the installation's own repository
   * listing through ({@link installationTokenRepoLister}).
   *
   * REQUIRED, and required on purpose: when the lister merely defaulted to the user-auth
   * client, the wrong endpoint was what you got by saying nothing. Now the only way to
   * build this service is to hand it something that can answer the installation's view.
   */
  appClient: Pick<GithubAppClient, "listInstallationRepos">;
  createProject: CreateProjectDelegate;
  /** Injected ONLY so unit tests never really wait (and so a fake clock can drive the
   *  bounded loop to its deadline in microseconds). Production uses `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected alongside `sleep` for the same reason. Production uses `Date.now`. */
  now?: () => number;
  installationVisibility?: InstallationVisibilityOptions;
  /** Override the gate's listing — see {@link InstallationRepoLister}.
   *
   *  As of 2026-07-31 nothing outside the unit lane uses this: the api e2e used to
   *  substitute a lister because the old endpoint was unreachable there, and now runs the
   *  real path. It stays because a bounded retry loop over an injected async function is
   *  the only cheap way to script "not yet, not yet, now" — the App-client fake would have
   *  to grow a page-scripting mode to say the same thing. */
  listInstallationRepos?: InstallationRepoLister;
}

/**
 * The create-new-repo JIT hop (Task #26, design-delta §2.3/§6b). The zero-storage
 * user-token dance that runs BEFORE the existing create-project+scaffold path,
 * because installation tokens cannot create a repo in a user's account.
 *
 * `createRepoAndProject`:
 *   1. require a GitHub connection (its installation is what the repo is added to,
 *      and what the scaffold workflow mints a token from) — else
 *      {@link GithubNotConnectedError} (409);
 *   2. exchange the user-authorization `code` for a short-lived `ghu_…` user token;
 *   3. `POST /user/repos` to create the repo (owner determined by GitHub);
 *   4. for a `selected`-mode installation, add the new repo to its access list;
 *   5. discard the user token (never persisted — it does not outlive step 4);
 *   6. WAIT, bounded, for the INSTALLATION to actually LIST the new repo (DR1), read
 *      with the App's own installation token — the same view dbos will walk;
 *   7. delegate to `createProject` with the CREATED repo's `{ owner, name }` →
 *      the same `{ projectId, jobId }` as `POST /v1/projects`.
 * Any provider failure in steps 2–4 becomes {@link RepoCreationError} (502), and a
 * step-5 timeout its {@link RepoNotVisibleError} subclass (same 502, better message);
 * the 409 preconditions (no connection / duplicate repo) surface unwrapped.
 */
export class RepoProvisioningService {
  private readonly prisma: PrismaClient;
  private readonly userAuthClient: GithubUserAuthClient;
  private readonly createProject: CreateProjectDelegate;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly visibility: Required<InstallationVisibilityOptions>;
  private readonly listInstallationRepos: InstallationRepoLister;

  constructor(opts: RepoProvisioningServiceOptions) {
    this.prisma = opts.prisma;
    this.userAuthClient = opts.userAuthClient;
    this.createProject = opts.createProject;
    this.listInstallationRepos =
      opts.listInstallationRepos ?? installationTokenRepoLister(opts.appClient);
    this.sleep =
      opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.visibility = { ...VISIBILITY_DEFAULTS, ...opts.installationVisibility };
  }

  /** The hosted GitHub user-authorization URL the wizard opens (no network). */
  authorizeUrl(args: { redirectUri: string; state: string }): string {
    return this.userAuthClient.buildAuthorizeUrl(args);
  }

  async createRepoAndProject(
    userId: string,
    req: CreateRepoRequest,
  ): Promise<{ projectId: string; jobId: string }> {
    // The repo is created under, and added to, the user's installation; the scaffold
    // workflow later mints an installation token from it. No connection → 409.
    const connection = await this.prisma.githubConnection.findUnique({
      where: { userId },
    });
    if (!connection) throw new GithubNotConnectedError();

    // The user token never leaves `provisionRepo`: its last use is the repo creation
    // itself. The gate below asks the INSTALLATION, with the installation's own
    // credential, so nothing here needs to hold a user credential open across it.
    const created = await this.provisionRepo(req, connection);

    // THE GATE (DR1). The repo now exists on GitHub — which is NOT the same as the
    // installation being able to see it, and it is the installation's view that the
    // scaffold workflow depends on.
    await this.awaitInstallationVisibility({
      installationId: connection.installationId,
      fullName: created.fullName,
    });

    // Delegate to the existing create-project+scaffold path with the CREATED repo's
    // GitHub-assigned owner + name. The gate above is what makes the workflow's
    // `ensureRepoReachable` step safe to enqueue against.
    // Feature 2: the wizard's picked passage rides through to the SAME seeding path the
    // "use existing empty repo" tab takes. Carrying it on only one of the two submit
    // paths would make the feature work on one tab and silently do nothing on the other.
    const scripture = (req as { scripture?: ProjectScripture }).scripture;
    return this.createProject(userId, {
      name: req.name,
      repoOwner: created.owner,
      repoName: created.name,
      visibility: req.visibility,
      createdFrom: req.createdFrom,
      ...(scripture !== undefined ? { scripture } : {}),
    });
  }

  /**
   * The product analogue of the e2e harness's `waitForInstallationVisibility`
   * ("Gate #2 before any workflow enqueue", root `tests/support/e2e-github-api.mjs`),
   * which has existed since task 62 and which the product itself never had.
   *
   * WHY IT IS MANDATORY, not defensive padding. `createProject` enqueues
   * `scaffoldProjectWorkflow`, whose step 2 is dbos's `ensureRepoReachable`
   * (`scaffold-project/github-rest.ts`): it walks `GET /installation/repositories` and
   * throws `RepoUnreachableError` when the repo is absent — a type
   * `isPermanentScaffoldFailure` classifies as PERMANENT, so `shouldRetry` is false and
   * the step fails on its FIRST attempt with no DBOS retry whatsoever. Under
   * `repository_selection: "all"` a brand-new repo IS covered by the installation, but
   * not INSTANTLY. So the window between `POST /user/repos` and the enqueue is a real
   * race, and losing it is not a slow start — it is a terminal one. Row 63 made the
   * consequence louder rather than rarer: `markJobFailed` turns the symptom from an
   * eternal spinner into an immediate hard `failed`, leaving the user with a real, empty
   * repository they never asked to keep.
   *
   * SHAPE, mirroring the harness: probe FIRST (so an already-visible repo — the common
   * case — pays exactly one round-trip and zero delay), then sleep with a doubling,
   * capped backoff, and re-check the deadline only after a probe. Same 60 s budget and
   * same 5 s cap as the harness, on purpose.
   *
   * A probe that THROWS counts as "not yet" and is retried inside the window rather than
   * aborting the create, so a single transient GitHub blip cannot fail a repo creation
   * that was otherwise fine; the last such failure is named in the timeout message (and
   * attached as `cause`) so a genuinely broken listing — a 401, say — is still diagnosed
   * rather than reported as a bare timeout.
   *
   * THE ALTERNATIVE NOT TAKEN, and why. The other repair is in dbos: make
   * `ensureRepoReachable`'s ABSENCE verdict transient for a bounded window (leave every
   * other failure permanent) so DBOS's own retry rides the race out. That is arguably
   * the better fix — it covers every enqueue path, including the ones that never come
   * through `createRepoAndProject` (`POST /v1/projects` on an existing repo, a re-run,
   * anything future), whereas this gate only covers the create-new hop. It was not taken
   * HERE because it lives in `supagloo-nodejs-dbos`, owned by another agent this pass,
   * and a half-applied cross-repo change is worse than either whole one. The two are
   * complementary, not exclusive: this gate would remain worth keeping even then,
   * because it fails the request SYNCHRONOUSLY — the user learns the repo is unusable
   * from the 502 they are already waiting on, instead of from a job that dies later.
   */
  private async awaitInstallationVisibility(args: {
    installationId: string;
    fullName: string;
  }): Promise<void> {
    const { timeoutMs, initialDelayMs, maxDelayMs } = this.visibility;
    // GitHub is case-insensitive about owner/repo names but preserves the case it was
    // given, and the listing is not guaranteed to echo the create response byte for byte.
    const wanted = args.fullName.toLowerCase();
    const deadline = this.now() + timeoutMs;
    let delay = initialDelayMs;
    let lastProbeError: unknown;

    for (;;) {
      try {
        const fullNames = await this.listInstallationRepos({
          installationId: args.installationId,
        });
        if (fullNames.some((name) => name.toLowerCase() === wanted)) return;
        lastProbeError = undefined;
      } catch (err) {
        lastProbeError = err;
      }
      if (this.now() >= deadline) break;
      await this.sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }

    // Never enqueue anyway and hope: see {@link RepoNotVisibleError}.
    throw new RepoNotVisibleError({
      repoFullName: args.fullName,
      installationId: args.installationId,
      timeoutMs,
      lastProbeError,
    });
  }

  /** Steps 2–4: exchange → create → (selected) add-to-installation.
   *  Any provider failure is wrapped as {@link RepoCreationError} (502).
   *
   *  The user token is a local of THIS method and nothing else. It used to be returned
   *  alongside the created repo so the visibility gate could re-use it; the gate now reads
   *  the installation's own view with the installation's own credential
   *  ({@link InstallationRepoLister}), so the shortest-lived credential in the system is
   *  back to the narrowest scope that can hold it. */
  private async provisionRepo(
    req: CreateRepoRequest,
    connection: { installationId: string; repositorySelection: string },
  ) {
    try {
      const { token } = await this.userAuthClient.exchangeCode(req.code);
      const created = await this.userAuthClient.createUserRepo({
        token,
        name: req.repoName,
        private: req.visibility === "private",
      });
      if (connection.repositorySelection === "selected") {
        await this.userAuthClient.addRepoToInstallation({
          token,
          installationId: connection.installationId,
          repositoryId: created.id,
        });
      }
      return created;
    } catch (err) {
      // Plan row 63 / D63.5: keep the reply's 502 + `repo_creation_failed` slug exactly
      // as the contract pins them, but stop DESTROYING the upstream status. A typed
      // `GithubCreateRepoError` carries GitHub's own status and words; every other
      // cause (a code-exchange failure, an installation-add failure) still collapses to
      // the generic message, as before.
      const upstreamStatus =
        err instanceof GithubCreateRepoError ? err.upstreamStatus : undefined;
      throw new RepoCreationError(
        upstreamStatus === undefined
          ? undefined
          : `failed to create the GitHub repository (GitHub returned ${upstreamStatus}): ` +
            `${(err as Error).message}`,
        { cause: err, upstreamStatus },
      );
    }
  }
}
