import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerProjectRoutes } from "./projects";
import { ProjectNotFoundError } from "../projects/errors";

// Thin-handler wiring for the projects surface (Task #14, design-delta §2.6/§8).
// Isolated from the DB with a FAKE service + FAKE auth, driven via app.inject. Every
// route requires the bearer session; ProjectNotFoundError maps to 404 (missing /
// foreign / soft-deleted are indistinguishable on the wire); a bad PATCH body is a
// 400 (Zod). Prisma-row fixtures (Date columns) prove the route maps rows→DTOs.

const PROJECT_ROW = {
  id: "p1",
  slug: "psalm-121",
  ownerId: "u1",
  name: "Psalm 121",
  repoOwner: "ashtable",
  repoName: "psalm-121",
  repoVisibility: "private",
  createdFrom: "blank",
  currentBranch: "v0.0.1",
  thumbnailAssetKey: null,
  lastRenderJobId: null,
  lastOpenedAt: new Date("2026-07-19T00:00:00.000Z"),
  createdAt: new Date("2026-07-18T00:00:00.000Z"),
  deletedAt: null,
};

const VERSION_ROW = {
  id: "v1",
  projectId: "p1",
  semver: "0.0.1",
  branchName: "v0.0.1",
  state: "working",
  commitMessage: null,
  autoSummary: null,
  changedFiles: [],
  headCommitSha: null,
  prNumber: null,
  prUrl: null,
  publishedAt: null,
};

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

function makeDeps(service: Record<string, any> = {}) {
  return {
    service: {
      listProjects: async () => [PROJECT_ROW],
      getProject: async () => PROJECT_ROW,
      renameProject: async () => PROJECT_ROW,
      deleteProject: async () => undefined,
      listVersions: async () => [VERSION_ROW],
      ...service,
    } as any,
  };
}

async function buildApp(
  deps: ReturnType<typeof makeDeps>,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(bearerAuthPlugin, { authService: fakeAuthService as any });
  registerProjectRoutes(app, deps);
  await app.ready();
  return app;
}

const BEARER = { authorization: "Bearer valid" };

describe("Project routes — auth", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  const routes: [string, string][] = [
    ["GET", "/projects"],
    ["GET", "/projects/p1"],
    ["PATCH", "/projects/p1"],
    ["DELETE", "/projects/p1"],
    ["GET", "/projects/p1/versions"],
  ];

  for (const [method, url] of routes) {
    it(`401s ${method} ${url} without a bearer token`, async () => {
      app = await buildApp(makeDeps());
      const res = await app.inject({
        method: method as any,
        url,
        payload: method === "PATCH" ? { name: "x" } : undefined,
      });
      expect(res.statusCode).toBe(401);
    });
  }
});

describe("Project routes — GET /projects (grid)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("returns { projects: [dto] } and passes the caller's id", async () => {
    let seenUserId: string | undefined;
    app = await buildApp(
      makeDeps({
        listProjects: async (userId: string) => {
          seenUserId = userId;
          return [PROJECT_ROW];
        },
      }),
    );
    const res = await app.inject({ method: "GET", url: "/projects", headers: BEARER });
    expect(res.statusCode).toBe(200);
    expect(seenUserId).toBe("u1");
    const body = res.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      id: "p1",
      slug: "psalm-121",
      name: "Psalm 121",
      lastOpenedAt: "2026-07-19T00:00:00.000Z",
    });
    // ownerId is not exposed on the wire.
    expect("ownerId" in body.projects[0]).toBe(false);
  });
});

describe("Project routes — GET /projects/:id", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("returns { project } and passes (userId, id)", async () => {
    let seen: { userId?: string; id?: string } = {};
    app = await buildApp(
      makeDeps({
        getProject: async (userId: string, id: string) => {
          seen = { userId, id };
          return PROJECT_ROW;
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/projects/p1",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ userId: "u1", id: "p1" });
    expect(res.json().project.id).toBe("p1");
  });

  it("maps ProjectNotFoundError to 404", async () => {
    app = await buildApp(
      makeDeps({
        getProject: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/projects/other",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Project routes — PATCH /projects/:id (rename)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("renames and returns { project }, passing (userId, id, name)", async () => {
    let seen: any = {};
    app = await buildApp(
      makeDeps({
        renameProject: async (userId: string, id: string, name: string) => {
          seen = { userId, id, name };
          return { ...PROJECT_ROW, name };
        },
      }),
    );
    const res = await app.inject({
      method: "PATCH",
      url: "/projects/p1",
      headers: BEARER,
      payload: { name: "Renamed" },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ userId: "u1", id: "p1", name: "Renamed" });
    expect(res.json().project.name).toBe("Renamed");
  });

  it("400s a body with no/empty name", async () => {
    app = await buildApp(makeDeps());
    const empty = await app.inject({
      method: "PATCH",
      url: "/projects/p1",
      headers: BEARER,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const blank = await app.inject({
      method: "PATCH",
      url: "/projects/p1",
      headers: BEARER,
      payload: { name: "" },
    });
    expect(blank.statusCode).toBe(400);
  });

  it("maps ProjectNotFoundError to 404", async () => {
    app = await buildApp(
      makeDeps({
        renameProject: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "PATCH",
      url: "/projects/other",
      headers: BEARER,
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Project routes — DELETE /projects/:id (soft delete)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("returns { ok: true } and passes (userId, id)", async () => {
    let seen: any = {};
    app = await buildApp(
      makeDeps({
        deleteProject: async (userId: string, id: string) => {
          seen = { userId, id };
        },
      }),
    );
    const res = await app.inject({
      method: "DELETE",
      url: "/projects/p1",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(seen).toEqual({ userId: "u1", id: "p1" });
  });

  it("maps ProjectNotFoundError (e.g. a re-delete) to 404", async () => {
    app = await buildApp(
      makeDeps({
        deleteProject: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "DELETE",
      url: "/projects/gone",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Project routes — GET /projects/:id/versions", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("returns { versions: [dto] } and passes (userId, id)", async () => {
    let seen: any = {};
    app = await buildApp(
      makeDeps({
        listVersions: async (userId: string, id: string) => {
          seen = { userId, id };
          return [VERSION_ROW];
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/projects/p1/versions",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ userId: "u1", id: "p1" });
    expect(res.json().versions[0].semver).toBe("0.0.1");
  });

  it("maps ProjectNotFoundError to 404", async () => {
    app = await buildApp(
      makeDeps({
        listVersions: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/projects/other/versions",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
  });
});
