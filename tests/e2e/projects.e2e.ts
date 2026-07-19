import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createPrismaClient,
  type PrismaClient,
  type Project,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { ProjectsService } from "../../src/projects/projects-service";

// Non-UI e2e for the projects/versions read+mutate surface (Task #14, design-delta
// §2.6/§8). Boots the REAL Fastify app in-process (real listen + real fetch) wired to
// the REAL Compose Postgres (`supagloo` DB). No mocking. Users are seeded via
// `/v1/test/seed`; Project/ProjectVersion rows are created directly with the test's
// own Prisma client (there is no create-project API endpoint yet — that's the later
// DBOS-backed #18). Exercises: CRUD round-trip, soft-delete (rows remain, vanish from
// the list), re-delete → 404, non-owner → 404 (never 403), the per-owner slug unique
// constraint, and real-semver version ordering. Runs IN-PROCESS per the
// in-flight-dblib-e2e constraint (the containerized API can't yet see the uncommitted
// db-lib DTOs). Infra ensured by tests/e2e/global-setup.ts (reuse-or-spawn).

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe("e2e: projects/versions read CRUD", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let baseUrl: string;

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: APP_URL });
    const authService = new AuthService({
      prisma,
      verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
      sessionTtlMs: SESSION_TTL_MS,
    });
    const projectsService = new ProjectsService({ prisma });

    app = buildApp({
      auth: {
        authService,
        env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
      },
      projects: { service: projectsService },
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
    const s = stamp();
    const token = `projects-e2e-${tag}-${s}`;
    const res = await fetch(`${baseUrl}/v1/test/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        users: [
          {
            youversionUserId: `yv-projects-${tag}-${s}`,
            displayName: `Projects E2E ${tag}`,
            email: `projects-${tag}-${s}@example.test`,
            avatarInitials: "PE",
            sessionToken: token,
          },
        ],
      }),
    });
    const body = await res.json();
    return { token, userId: body.users[0].user.id };
  }

  async function makeProject(
    ownerId: string,
    opts: { slug?: string; name?: string; lastOpenedAt?: Date } = {},
  ): Promise<Project> {
    const slug = opts.slug ?? `proj-e2e-${stamp()}`;
    return prisma.project.create({
      data: {
        slug,
        ownerId,
        name: opts.name ?? slug,
        repoOwner: "ashtable",
        repoName: slug,
        repoVisibility: "private",
        createdFrom: "blank",
        currentBranch: "v0.0.1",
        ...(opts.lastOpenedAt ? { lastOpenedAt: opts.lastOpenedAt } : {}),
      },
    });
  }

  async function makeVersion(projectId: string, semver: string): Promise<void> {
    await prisma.projectVersion.create({
      data: {
        projectId,
        semver,
        branchName: `v${semver}`,
        state: "working",
        changedFiles: [],
      },
    });
  }

  const api = (
    path: string,
    token?: string,
    init: { method?: string; body?: unknown } = {},
  ) =>
    fetch(`${baseUrl}/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  // --------------------------------------------------------------- CRUD round-trip

  it("lists, reads, and renames the owner's projects (slug stays stable)", async () => {
    const owner = await seedUser("crud");
    const older = await makeProject(owner.userId, {
      name: "Older",
      lastOpenedAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    const newer = await makeProject(owner.userId, {
      name: "Newer",
      lastOpenedAt: new Date("2026-07-18T00:00:00.000Z"),
    });

    // GET /projects — owner-scoped, most-recently-opened first.
    const list = await api("/projects", owner.token);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    const ids = listBody.projects.map((p: any) => p.id);
    expect(ids).toEqual([newer.id, older.id]);
    // ownerId never leaks on the wire.
    expect("ownerId" in listBody.projects[0]).toBe(false);

    // GET /projects/:id
    const one = await api(`/projects/${newer.id}`, owner.token);
    expect(one.status).toBe(200);
    expect((await one.json()).project.slug).toBe(newer.slug);

    // PATCH rename — name changes, slug is untouched.
    const renamed = await api(`/projects/${newer.id}`, owner.token, {
      method: "PATCH",
      body: { name: "Renamed Title" },
    });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json();
    expect(renamedBody.project.name).toBe("Renamed Title");
    expect(renamedBody.project.slug).toBe(newer.slug);

    // GET reflects the new name.
    const reread = await api(`/projects/${newer.id}`, owner.token);
    expect((await reread.json()).project.name).toBe("Renamed Title");
  });

  // ----------------------------------------------------------------- soft delete

  it("soft-deletes: vanishes from the list + 404s by id, but the row remains", async () => {
    const owner = await seedUser("del");
    const project = await makeProject(owner.userId, { name: "To Delete" });

    const del = await api(`/projects/${project.id}`, owner.token, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    // Gone from the list and by id.
    const list = await api("/projects", owner.token);
    const ids = (await list.json()).projects.map((p: any) => p.id);
    expect(ids).not.toContain(project.id);

    const get = await api(`/projects/${project.id}`, owner.token);
    expect(get.status).toBe(404);

    // ...but the row still exists in the DB, with deletedAt set.
    const row = await prisma.project.findUnique({ where: { id: project.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();

    // Re-delete / mutate on an already-deleted project → uniform 404.
    const reDel = await api(`/projects/${project.id}`, owner.token, {
      method: "DELETE",
    });
    expect(reDel.status).toBe(404);
    const rePatch = await api(`/projects/${project.id}`, owner.token, {
      method: "PATCH",
      body: { name: "nope" },
    });
    expect(rePatch.status).toBe(404);
  });

  // ------------------------------------------------------------------- ownership

  it("hides one owner's projects from another and 404s (never 403) cross-owner access", async () => {
    const owner = await seedUser("owner");
    const other = await seedUser("other");
    const project = await makeProject(owner.userId, { name: "Owner Only" });

    // Not in the other user's list.
    const otherList = await api("/projects", other.token);
    const ids = (await otherList.json()).projects.map((p: any) => p.id);
    expect(ids).not.toContain(project.id);

    // Every per-id route → 404 (indistinguishable from not-found; never 403).
    expect((await api(`/projects/${project.id}`, other.token)).status).toBe(404);
    expect(
      (
        await api(`/projects/${project.id}`, other.token, {
          method: "PATCH",
          body: { name: "hijack" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await api(`/projects/${project.id}`, other.token, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(
      (await api(`/projects/${project.id}/versions`, other.token)).status,
    ).toBe(404);

    // The owner still sees it untouched.
    expect((await api(`/projects/${project.id}`, owner.token)).status).toBe(200);
  });

  // -------------------------------------------------------- per-owner slug unique

  it("allows two owners to share a slug but rejects a duplicate for one owner", async () => {
    const a = await seedUser("slug-a");
    const b = await seedUser("slug-b");
    const slug = `psalm-121-${stamp()}`;

    await makeProject(a.userId, { slug }); // ok
    await makeProject(b.userId, { slug }); // ok — different owner, same slug

    let code: string | undefined;
    try {
      await makeProject(a.userId, { slug }); // same owner + slug → constraint
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("P2002");
  });

  // ---------------------------------------------------------------- version order

  it("returns versions ordered by real semver descending (numeric, not lexical)", async () => {
    const owner = await seedUser("versions");
    const project = await makeProject(owner.userId, { name: "Versioned" });
    // Create out of order; 0.10.0 must come out ABOVE 0.2.0 (numeric, not lexical).
    await makeVersion(project.id, "0.2.0");
    await makeVersion(project.id, "0.10.0");
    await makeVersion(project.id, "0.0.1");

    const res = await api(`/projects/${project.id}/versions`, owner.token);
    expect(res.status).toBe(200);
    const semvers = (await res.json()).versions.map((v: any) => v.semver);
    expect(semvers).toEqual(["0.10.0", "0.2.0", "0.0.1"]);
  });

  // --------------------------------------------------------------------- no auth

  it("401s every route without a bearer token", async () => {
    expect((await api("/projects")).status).toBe(401);
    expect((await api("/projects/anything")).status).toBe(401);
    expect((await api("/projects/anything/versions")).status).toBe(401);
  });
});
