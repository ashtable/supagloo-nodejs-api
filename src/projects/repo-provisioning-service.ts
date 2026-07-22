import type {
  CreateProjectRequest,
  CreateRepoRequest,
  PrismaClient,
} from "@supagloo/database-lib";
import { GithubNotConnectedError } from "../connections/errors";
import type { GithubUserAuthClient } from "../connections/github-user-auth-client";
import { RepoCreationError } from "./repo-provisioning-errors";

/** The create-project+scaffold delegate (task-18 `ProjectJobsService.createProjectWithScaffold`),
 *  injected as a seam so this service depends only on the create CONTRACT, not the
 *  whole ProjectJobsService class. */
export type CreateProjectDelegate = (
  userId: string,
  req: CreateProjectRequest,
) => Promise<{ projectId: string; jobId: string }>;

export interface RepoProvisioningServiceOptions {
  prisma: PrismaClient;
  userAuthClient: GithubUserAuthClient;
  createProject: CreateProjectDelegate;
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
 *   5. discard the user token (never persisted);
 *   6. delegate to `createProject` with the CREATED repo's `{ owner, name }` →
 *      the same `{ projectId, jobId }` as `POST /v1/projects`.
 * Any provider failure in steps 2–4 becomes {@link RepoCreationError} (502); the
 * 409 preconditions (no connection / duplicate repo) surface unwrapped.
 */
export class RepoProvisioningService {
  private readonly prisma: PrismaClient;
  private readonly userAuthClient: GithubUserAuthClient;
  private readonly createProject: CreateProjectDelegate;

  constructor(opts: RepoProvisioningServiceOptions) {
    this.prisma = opts.prisma;
    this.userAuthClient = opts.userAuthClient;
    this.createProject = opts.createProject;
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

    const created = await this.provisionRepo(req, connection);

    // Delegate to the existing create-project+scaffold path with the CREATED repo's
    // GitHub-assigned owner + name (the repo now exists, so `ensureRepoAccessible`
    // in the scaffold workflow passes).
    return this.createProject(userId, {
      name: req.name,
      repoOwner: created.owner,
      repoName: created.name,
      visibility: req.visibility,
      createdFrom: req.createdFrom,
    });
  }

  /** Steps 2–4: exchange → create → (selected) add-to-installation → discard token.
   *  Any provider failure is wrapped as {@link RepoCreationError} (502). */
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
      // The user token goes out of scope here — never stored.
      return created;
    } catch (err) {
      throw new RepoCreationError(undefined, { cause: err });
    }
  }
}
