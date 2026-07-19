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
  /** Mints a fresh installation token and lists the granted repos. */
  listInstallationRepos(args: {
    installationId: string;
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
   */
  async listRepos(
    userId: string,
    opts: { filter: GithubRepoFilter; q?: string },
  ): Promise<GithubRepo[]> {
    const connection = await this.prisma.githubConnection.findUnique({
      where: { userId },
    });
    if (!connection) throw new GithubNotConnectedError();

    const repos = await this.listInstallationRepos({
      installationId: connection.installationId,
    });
    return filterRepos(repos, opts);
  }
}
