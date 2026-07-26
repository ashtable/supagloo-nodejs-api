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
import {
  RepoCreationError,
  RepoNotVisibleError,
} from "./repo-provisioning-errors";

/** The create-project+scaffold delegate (task-18 `ProjectJobsService.createProjectWithScaffold`),
 *  injected as a seam so this service depends only on the create CONTRACT, not the
 *  whole ProjectJobsService class. */
export type CreateProjectDelegate = (
  userId: string,
  req: CreateProjectRequest,
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
 * It defaults to `userAuthClient.listInstallationRepos` — `GET
 * /user/installations/:id/repositories`, the only installation listing reachable with
 * the short-lived user token this flow already holds. The seam exists because that
 * endpoint requires a token **authorized to the GitHub App**, so the api e2e — which
 * fakes the user token's PROVENANCE with a PAT (design-delta §10.2), and only its
 * provenance — is refused by GitHub with a 403 there ("You must authenticate with an
 * access token authorized to a GitHub App…", verified live). That lane injects a lister
 * over `GET /installation/repositories` with a real installation token instead, which is
 * the STRICTER read: it is byte-for-byte the view dbos's `ensureRepoReachable` consults.
 *
 * See also the report note: the ideal production wiring is that same installation-token
 * listing (`githubAppClient.listInstallationRepos`, already built one scope away in
 * `server.ts`), which would make the seam's default and the e2e's override the same
 * endpoint. It is a one-line change in `server.ts`, a file this pass does not own.
 */
export type InstallationRepoLister = (args: {
  token: string;
  installationId: string;
}) => Promise<string[]>;

const VISIBILITY_DEFAULTS = {
  timeoutMs: 60_000,
  initialDelayMs: 1_000,
  maxDelayMs: 5_000,
} as const;

export interface RepoProvisioningServiceOptions {
  prisma: PrismaClient;
  userAuthClient: GithubUserAuthClient;
  createProject: CreateProjectDelegate;
  /** Injected ONLY so unit tests never really wait (and so a fake clock can drive the
   *  bounded loop to its deadline in microseconds). Production uses `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected alongside `sleep` for the same reason. Production uses `Date.now`. */
  now?: () => number;
  installationVisibility?: InstallationVisibilityOptions;
  /** Override the gate's listing — see {@link InstallationRepoLister}. */
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
 *   5. WAIT, bounded, for the installation to actually LIST the new repo (DR1);
 *   6. discard the user token (never persisted);
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
      opts.listInstallationRepos ??
      ((args) => opts.userAuthClient.listInstallationRepos(args));
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

    const { created, token } = await this.provisionRepo(req, connection);

    // THE GATE (DR1). The repo now exists on GitHub — which is NOT the same as the
    // installation being able to see it, and it is the installation's view that the
    // scaffold workflow depends on.
    await this.awaitInstallationVisibility({
      token,
      installationId: connection.installationId,
      fullName: created.fullName,
    });
    // Only NOW does the user token go out of scope for good — never persisted, and its
    // last use is a read.

    // Delegate to the existing create-project+scaffold path with the CREATED repo's
    // GitHub-assigned owner + name. The gate above is what makes the workflow's
    // `ensureRepoReachable` step safe to enqueue against.
    return this.createProject(userId, {
      name: req.name,
      repoOwner: created.owner,
      repoName: created.name,
      visibility: req.visibility,
      createdFrom: req.createdFrom,
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
    token: string;
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
          token: args.token,
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
   *  Returns the user token alongside the created repo so the caller's visibility gate
   *  can issue its read with the SAME short-lived credential. It stays a local of one
   *  `createRepoAndProject` call and is still never persisted, logged or returned to the
   *  client — widening its scope by one frame is the price of gating on a listing this
   *  service can reach without a second credential. */
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
      return { created, token };
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
