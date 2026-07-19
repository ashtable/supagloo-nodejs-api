import {
  compareSemver,
  type PrismaClient,
  type Project,
  type ProjectVersion,
} from "@supagloo/database-lib";
import { ProjectNotFoundError } from "./errors";

/**
 * Project/ProjectVersion read + mutate service (design-delta §2.6/§8). Backs the
 * five routes of Task #14: the workspace grid, per-project get/rename/soft-delete,
 * and the version list. All operations are OWNER-SCOPED and SOFT-DELETE-AWARE:
 *
 *   - reads/mutations resolve a project only when it is owned by the caller AND not
 *     soft-deleted; anything else (missing / foreign / deleted) surfaces uniformly as
 *     {@link ProjectNotFoundError} (404) so existence never leaks;
 *   - rename touches ONLY `name` — the slug is a stable URL identity (`/studio/[slug]`)
 *     and is never regenerated;
 *   - delete is SOFT (sets `deletedAt`; the row remains for audit/restore), which is
 *     why a second delete on the same project 404s (it is already invisible);
 *   - versions are ordered by REAL semver descending — `semver` is free-form and
 *     non-zero-padded, so lexical ordering is wrong (`"0.10.0" < "0.2.0"` lexically).
 *
 * A pure DB reader/writer (no HTTP, no encryption) so the scoping + ordering logic is
 * fully unit-testable with a fake Prisma. Rows are mapped to wire DTOs by the route.
 */
export interface ProjectsServiceOptions {
  prisma: PrismaClient;
  /** Injectable clock for a deterministic soft-delete `deletedAt`. Defaults to
   *  wall-clock. */
  now?: () => Date;
}

export class ProjectsService {
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(opts: ProjectsServiceOptions) {
    this.prisma = opts.prisma;
    this.now = opts.now ?? (() => new Date());
  }

  /** The owner's non-deleted projects, most-recently-opened first (workspace grid). */
  async listProjects(userId: string): Promise<Project[]> {
    return this.prisma.project.findMany({
      where: { ownerId: userId, deletedAt: null },
      orderBy: { lastOpenedAt: "desc" },
    });
  }

  /**
   * Resolve one project scoped to the caller and not soft-deleted.
   * @throws {ProjectNotFoundError} when there is no such visible project.
   */
  async getProject(userId: string, id: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId: userId, deletedAt: null },
    });
    if (!project) throw new ProjectNotFoundError();
    return project;
  }

  /**
   * Rename a project (the only editable field). The slug is deliberately left
   * untouched — it is a stable URL identifier.
   * @throws {ProjectNotFoundError} when the project is not visible to the caller.
   */
  async renameProject(
    userId: string,
    id: string,
    name: string,
  ): Promise<Project> {
    await this.getProject(userId, id); // owner + soft-delete scoping (throws 404)
    return this.prisma.project.update({ where: { id }, data: { name } });
  }

  /**
   * Soft-delete a project (set `deletedAt`; the row is retained). A repeat delete on
   * an already-deleted project throws {@link ProjectNotFoundError} — it is already
   * invisible.
   */
  async deleteProject(userId: string, id: string): Promise<void> {
    await this.getProject(userId, id); // throws 404 if missing/foreign/already-deleted
    await this.prisma.project.update({
      where: { id },
      data: { deletedAt: this.now() },
    });
  }

  /**
   * List a project's versions ordered by real semver DESCENDING (newest first — the
   * 14b dropdown), with a deterministic `id`-descending tiebreak for equal/unparseable
   * semvers. The project is resolved first (owner + soft-delete scoping) so versions of
   * a foreign/deleted project never leak.
   * @throws {ProjectNotFoundError} when the project is not visible to the caller.
   */
  async listVersions(userId: string, id: string): Promise<ProjectVersion[]> {
    await this.getProject(userId, id);
    const versions = await this.prisma.projectVersion.findMany({
      where: { projectId: id },
    });
    return [...versions].sort((a, b) => {
      const bySemver = compareSemver(b.semver, a.semver); // descending
      if (bySemver !== 0) return bySemver;
      if (a.id === b.id) return 0;
      return a.id < b.id ? 1 : -1; // id descending, stable
    });
  }
}
