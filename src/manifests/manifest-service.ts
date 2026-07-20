import {
  ProjectManifestSchema,
  type PrismaClient,
  type Project,
  type ProjectManifest,
} from "@supagloo/database-lib";
import type { GithubFileContents } from "../connections/github-app-client";
import { GithubNotConnectedError } from "../connections/errors";
import { ManifestInvalidError, ManifestNotFoundError } from "./errors";

/** The manifest's fixed location at the repo root (design-delta §2.11). Matches the
 *  DBOS import-verify `MANIFEST_FILE` constant. */
export const MANIFEST_FILE = "supagloo.project.json";

/**
 * Manifest read (design-delta §5.3/§6b/§8) — backs `GET /v1/projects/:id/manifest?ref=`.
 * A synchronous, in-process read (NOT a DBOS workflow, per §7): resolve the project
 * (owner-scoped 404 gate), mint a fresh installation token, read `supagloo.project.json`
 * at `ref` via the GitHub Contents API, base64-decode → JSON-parse → validate against
 * `ProjectManifestSchema`, and return the Zod-parsed manifest.
 *
 * Pure orchestration over three injected seams so every branch is unit-testable with no
 * DB and no network:
 *   - `getProject` — the owner-scoped + soft-delete-aware resolver (ProjectsService.
 *     getProject); throws `ProjectNotFoundError` (404) for missing/foreign/deleted. Run
 *     FIRST so a foreign/deleted project never leaks and the caller is proven the owner.
 *   - `prisma` — the caller's `GithubConnection` lookup (caller == owner, guaranteed by
 *     `getProject`), for the `installationId`.
 *   - `getFileContents` — the github contents-client read (mints the token internally,
 *     returns `null` on a 404).
 */
export interface ManifestServiceOptions {
  /** Owner-scoped project resolver (throws `ProjectNotFoundError` → 404). */
  getProject(userId: string, id: string): Promise<Project>;
  /** For the caller's GitHub connection lookup (the owner's `installationId`). */
  prisma: PrismaClient;
  /** Contents-API read; `null` on a GitHub 404. */
  getFileContents(args: {
    installationId: string;
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<GithubFileContents | null>;
}

export class ManifestService {
  private readonly getProject: ManifestServiceOptions["getProject"];
  private readonly prisma: PrismaClient;
  private readonly getFileContents: ManifestServiceOptions["getFileContents"];

  constructor(opts: ManifestServiceOptions) {
    this.getProject = opts.getProject;
    this.prisma = opts.prisma;
    this.getFileContents = opts.getFileContents;
  }

  /**
   * Read + validate the manifest for `projectId` at `ref` (defaulting to the project's
   * `currentBranch`).
   * @throws {ProjectNotFoundError} (404) project missing / foreign / soft-deleted.
   * @throws {GithubNotConnectedError} (409) the owner has no GitHub connection.
   * @throws {ManifestNotFoundError} (404) the file/branch/repo is absent on GitHub.
   * @throws {ManifestInvalidError} (422) the file exists but is not a valid manifest.
   */
  async readManifest(
    userId: string,
    projectId: string,
    ref?: string,
  ): Promise<ProjectManifest> {
    // Owner + soft-delete scoping (throws 404). Also proves the caller is the owner,
    // so the connection lookup below can key off the caller's userId.
    const project = await this.getProject(userId, projectId);

    const connection = await this.prisma.githubConnection.findUnique({
      where: { userId },
    });
    if (!connection) throw new GithubNotConnectedError();

    const resolvedRef = ref ?? project.currentBranch;

    const file = await this.getFileContents({
      installationId: connection.installationId,
      owner: project.repoOwner,
      repo: project.repoName,
      path: MANIFEST_FILE,
      ref: resolvedRef,
    });
    if (!file) {
      throw new ManifestNotFoundError(
        `${MANIFEST_FILE} not found in ${project.repoOwner}/${project.repoName} at ${resolvedRef}`,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(file.content);
    } catch {
      throw new ManifestInvalidError(`${MANIFEST_FILE} is not valid JSON`);
    }

    const parsed = ProjectManifestSchema.safeParse(json);
    if (!parsed.success) {
      throw new ManifestInvalidError(
        `${MANIFEST_FILE} does not match the project manifest schema`,
      );
    }
    return parsed.data;
  }
}
