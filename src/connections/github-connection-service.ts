import type {
  GithubConnection,
  GithubRepo,
  GithubRepoFilter,
  PrismaClient,
} from "@supagloo/database-lib";
import type { VerifiedInstallation } from "./github-app-client";
import { filterRepos } from "./repo-filter";
import {
  GithubNotConnectedError,
  InstallationVerificationError,
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
  /** Injectable for deterministic tests; defaults to wall-clock. */
  clock?: () => Date;
}

export class GithubConnectionService {
  private readonly prisma: PrismaClient;
  private readonly verifyInstallation: GithubConnectionServiceOptions["verifyInstallation"];
  private readonly listInstallationRepos: GithubConnectionServiceOptions["listInstallationRepos"];
  private readonly oauthBaseUrl: string;
  private readonly appSlug: string;
  private readonly clock: () => Date;

  constructor(opts: GithubConnectionServiceOptions) {
    this.prisma = opts.prisma;
    this.verifyInstallation = opts.verifyInstallation;
    this.listInstallationRepos = opts.listInstallationRepos;
    this.oauthBaseUrl = opts.oauthBaseUrl.replace(/\/+$/, "");
    this.appSlug = opts.appSlug;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** The GitHub App's hosted installation-picker URL. No network call. */
  installUrl(): string {
    return `${this.oauthBaseUrl}/apps/${this.appSlug}/installations/new`;
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
