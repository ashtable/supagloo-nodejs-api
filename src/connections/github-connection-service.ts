import type {
  GithubConnection,
  GithubRepo,
  GithubRepoFilter,
  PrismaClient,
} from "@supagloo/database-lib";
import type { VerifiedInstallation } from "./github-app-client";
import type {
  GithubUserAuthClient,
  UserInstallation,
} from "./github-user-auth-client";
import { filterRepos } from "./repo-filter";
import {
  AmbiguousUserInstallationError,
  GithubNotConnectedError,
  InstallationVerificationError,
  NoUserInstallationError,
} from "./errors";

/**
 * All GitHub App connection data-access + policy (design-delta §2.3/§6a). Kept
 * behind one class so the routes stay thin and every branch is unit-testable with
 * a fake Prisma + fake outbound closures + fixed clock (mirrors `AuthService`).
 *
 * The outbound HTTP/JWT work is injected as two closures (from
 * `makeGithubAppClient`), NOT performed here — so the service never touches an App
 * JWT or an installation token, and the "mint fresh per call, never store"
 * invariant lives entirely inside `listInstallationRepos`.
 */
export interface GithubConnectionServiceOptions {
  prisma: PrismaClient;
  /** App-JWT `GET /app/installations/:id` — returns null when GitHub has no such
   *  installation. */
  verifyInstallation(
    installationId: string,
  ): Promise<VerifiedInstallation | null>;
  /** Mints a fresh installation token and lists the granted repos. `deriveEmptinessFor`
   *  selects the repos worth an authoritative `empty` verdict — omitted ⇒ no probe at
   *  all. See {@link GithubConnectionService.listRepos} for how the query decides. */
  listInstallationRepos(args: {
    installationId: string;
    deriveEmptinessFor?: (repo: GithubRepo) => boolean;
  }): Promise<GithubRepo[]>;
  /** GitHub's OAuth host (`https://github.com`), for the hosted install URL. */
  oauthBaseUrl: string;
  /** The GitHub App's URL slug (the install page is addressed by slug, not id). */
  appSlug: string;
  /**
   * The USER-authorization surface behind {@link GithubConnectionService.linkExisting}
   * — the same client the create-repo JIT hop uses, narrowed to the three calls needed
   * here. REQUIRED rather than optional on purpose: a silently-unwired capability
   * dead-ends the user at exactly the point this exists to unblock.
   */
  userAuth: Pick<
    GithubUserAuthClient,
    "buildAuthorizeUrl" | "exchangeCode" | "listUserInstallations"
  >;
  /** Injectable for deterministic tests; defaults to wall-clock. */
  clock?: () => Date;
}

export class GithubConnectionService {
  private readonly prisma: PrismaClient;
  private readonly verifyInstallation: GithubConnectionServiceOptions["verifyInstallation"];
  private readonly listInstallationRepos: GithubConnectionServiceOptions["listInstallationRepos"];
  private readonly oauthBaseUrl: string;
  private readonly appSlug: string;
  private readonly userAuth: GithubConnectionServiceOptions["userAuth"];
  private readonly clock: () => Date;

  constructor(opts: GithubConnectionServiceOptions) {
    this.prisma = opts.prisma;
    this.verifyInstallation = opts.verifyInstallation;
    this.listInstallationRepos = opts.listInstallationRepos;
    this.oauthBaseUrl = opts.oauthBaseUrl.replace(/\/+$/, "");
    this.appSlug = opts.appSlug;
    this.userAuth = opts.userAuth;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** The GitHub App's hosted installation-picker URL. No network call. */
  installUrl(): string {
    return `${this.oauthBaseUrl}/apps/${this.appSlug}/installations/new`;
  }

  /** The hosted GitHub USER-authorization URL for {@link linkExisting}. No network
   *  call, and no user secret crosses the wire. */
  authorizeUrl(args: { redirectUri: string; state: string }): string {
    return this.userAuth.buildAuthorizeUrl(args);
  }

  /**
   * Connect an installation the user ALREADY has, using a user-authorization `code`.
   *
   * The install callback cannot reach this case. GitHub redirects to the App's Setup
   * URL only when an installation is CREATED, so a reinstall, an install made from
   * GitHub's directory, or one App registration shared across environments produces no
   * callback and no `installationId` — leaving the connect flow with nowhere to go.
   * Here we ask GitHub instead: exchange the code for a short-lived user token, read
   * the installations that user can reach, and pick.
   *
   * The token is used for that ONE read and never persisted — the same zero-storage
   * posture as the create-repo hop.
   *
   * Selection never guesses. `GET /user/installations` has no documented ordering, so
   * taking the first would silently wire a user's projects to whichever account GitHub
   * happened to list first — a wrong answer that looks like a right one and persists.
   * See {@link selectInstallation}.
   *
   * Resolution goes through {@link connectFromCallback}, so the installation is still
   * App-JWT verified and `githubLogin`/`repositorySelection` still come from GitHub
   * rather than from this listing. One persistence path, one verification path.
   */
  async linkExisting(userId: string, code: string): Promise<GithubConnection> {
    const { token } = await this.userAuth.exchangeCode(code);
    const installations = await this.userAuth.listUserInstallations(token);
    const selected = selectInstallation(installations);
    return this.connectFromCallback(userId, selected.installationId);
  }

  /**
   * Verify the installation via an App JWT, then store the connection for `userId`
   * (design-delta §6a). Persists ONLY the installation pointer + display fields —
   * never a repo token. Throws {@link InstallationVerificationError} (→ 400) when
   * GitHub has no such installation.
   */
  async connectFromCallback(
    userId: string,
    installationId: string,
  ): Promise<GithubConnection> {
    const verified = await this.verifyInstallation(installationId);
    if (!verified) {
      throw new InstallationVerificationError(
        `installation ${installationId} could not be verified`,
      );
    }

    const now = this.clock();
    const data = {
      githubLogin: verified.githubLogin,
      installationId,
      repositorySelection: verified.repositorySelection,
      status: "connected",
      connectedAt: now,
    };

    return this.prisma.githubConnection.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  /** Remove the stored connection (idempotent — `deleteMany` on a 0-count is a
   *  no-op, so a double-disconnect does not throw). */
  async disconnect(userId: string): Promise<void> {
    await this.prisma.githubConnection.deleteMany({ where: { userId } });
  }

  /**
   * Live repo listing for `userId` (design-delta §8): mint a fresh installation
   * token, list the granted repos, and apply `filter`/`q` in-process. Throws
   * {@link GithubNotConnectedError} (→ 409) when the user has no connection.
   *
   * **This method also prices plan row 65's emptiness probe** (deferred review finding
   * DR2). The probe costs one extra GitHub request per `size: 0` candidate, and it used
   * to run inside `listInstallationRepos` over the FULL installation listing — i.e.
   * before the narrowing below, for every caller, whether or not it read `empty`. On the
   * live installation (582 repos, 55 of them `size: 0`) that made `GET /v1/github/repos`
   * cost ~62 GitHub requests, and nextjs's `SessionProvider` issues that request on every
   * hard page load of every page just to render an "N repos accessible" COUNT: ~80 page
   * loads to exhaust a ~5,000/hour installation budget. The listing GETs throw on
   * exhaustion, so the picker failed outright rather than degrading.
   *
   * This is the only layer that knows the caller's intent, so this is where it becomes a
   * probe budget:
   *
   *   • `filter=empty` — `empty` is the FILTER, so an authoritative verdict is the
   *     answer itself. Wireframe 13a's picker also gates `data-disabled` on it. Probe.
   *   • a non-blank `q` — a targeted lookup whose fan-out is bounded by the narrowing,
   *     so the verdict can be authoritative without costing the whole account.
   *   • neither — the unnarrowed `filter=all` listing, which is exactly the page-load
   *     repo-count call. Probe NOTHING; `empty` falls back to the provisional
   *     `size === 0` reading (the pre-row-65 answer, ungated in every caller that asks
   *     this way).
   *
   * The predicate is expressed as `filterRepos([repo], opts)` rather than as a second
   * copy of the match, so "probe only what survives the narrowing" cannot drift from the
   * narrowing itself: there is ONE implementation and both stages call it.
   */
  async listRepos(
    userId: string,
    opts: { filter: GithubRepoFilter; q?: string },
  ): Promise<GithubRepo[]> {
    const connection = await this.prisma.githubConnection.findUnique({
      where: { userId },
    });
    if (!connection) throw new GithubNotConnectedError();

    const narrows = opts.filter === "empty" || (opts.q?.trim() ?? "") !== "";
    const repos = await this.listInstallationRepos({
      installationId: connection.installationId,
      deriveEmptinessFor: narrows
        ? (repo) => filterRepos([repo], opts).length === 1
        : undefined,
    });
    return filterRepos(repos, opts);
  }
}

/**
 * Choose which of the user's installations to connect.
 *
 * The rules, in order:
 *   1. none            → {@link NoUserInstallationError}. The user authorized us but
 *                        has not installed the App; their next step is the picker.
 *   2. exactly one     → that one. The overwhelmingly common shape.
 *   3. exactly one personal (`target_type: "User"`) → that one. A user who belongs to
 *                        organizations gets their OWN account, which is what "connect
 *                        my GitHub" means and what the install-picker flow would also
 *                        have produced.
 *   4. anything else   → {@link AmbiguousUserInstallationError}.
 *
 * Rule 4 is a refusal, not a fallback, and that is the point. Two org installations
 * and no personal one is a real shape, GitHub documents no ordering for this listing,
 * and picking arbitrarily would attach a user's repositories to the wrong
 * organization — persistently, and with no error for anyone to notice.
 */
export function selectInstallation(
  installations: readonly UserInstallation[],
): UserInstallation {
  if (installations.length === 0) throw new NoUserInstallationError();
  if (installations.length === 1) return installations[0]!;

  const personal = installations.filter((i) => i.targetType === "User");
  if (personal.length === 1) return personal[0]!;

  throw new AmbiguousUserInstallationError(
    `${installations.length} GitHub installations match ` +
      `(${installations.map((i) => i.accountLogin || "?").join(", ")}); ` +
      "choose one via the installation picker",
  );
}
