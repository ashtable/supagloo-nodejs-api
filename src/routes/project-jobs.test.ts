import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerProjectJobRoutes } from "./project-jobs";
import {
  GitOpsInFlightError,
  ProjectAlreadyExistsError,
} from "../jobs/errors";
import { GithubNotConnectedError } from "../connections/errors";

// Thin-handler wiring for the Task #19 import endpoint (design-delta §7 workflow 2 /
// §8). Isolated from the DB with a FAKE service + FAKE auth, driven via app.inject.
// `POST /v1-less /projects/import` requires the bearer session; it reuses the three
// task-18 409 codes (github_not_connected / git_ops_in_flight / project_exists) and a
// bad body is a 400 (Zod). No createdFrom is accepted (import is always import).

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

function makeService(overrides: Record<string, any> = {}) {
  return {
    createProjectWithScaffold: async () => ({ projectId: "p", jobId: "j" }),
    createProjectFromImport: async () => ({ projectId: "imp-p", jobId: "imp-j" }),
    getJob: async () => ({}),
    ...overrides,
  } as any;
}

async function buildTestApp(service: any): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(bearerAuthPlugin, { authService: fakeAuthService as any });
  registerProjectJobRoutes(app, { service });
  await app.ready();
  return app;
}

const BEARER = { authorization: "Bearer valid" };
const IMPORT_BODY = {
  name: "Imported Psalm",
  repoOwner: "ashtable",
  repoName: "psalm-121",
  visibility: "private",
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /projects/import", () => {
  it("201s with { projectId, jobId } on success", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/projects/import",
      headers: BEARER,
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ projectId: "imp-p", jobId: "imp-j" });
  });

  it("passes the owner id + request through to the service", async () => {
    let seen: any;
    app = await buildTestApp(
      makeService({
        createProjectFromImport: async (userId: string, req: unknown) => {
          seen = { userId, req };
          return { projectId: "imp-p", jobId: "imp-j" };
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/projects/import",
      headers: BEARER,
      payload: IMPORT_BODY,
    });
    expect(seen.userId).toBe("u1");
    expect(seen.req).toMatchObject({
      repoOwner: "ashtable",
      repoName: "psalm-121",
      visibility: "private",
    });
  });

  it("maps GithubNotConnectedError → 409 github_not_connected", async () => {
    app = await buildTestApp(
      makeService({
        createProjectFromImport: async () => {
          throw new GithubNotConnectedError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/import",
      headers: BEARER,
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("github_not_connected");
  });

  it("maps GitOpsInFlightError → 409 git_ops_in_flight", async () => {
    app = await buildTestApp(
      makeService({
        createProjectFromImport: async () => {
          throw new GitOpsInFlightError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/import",
      headers: BEARER,
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("git_ops_in_flight");
  });

  it("maps ProjectAlreadyExistsError → 409 project_exists", async () => {
    app = await buildTestApp(
      makeService({
        createProjectFromImport: async () => {
          throw new ProjectAlreadyExistsError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/import",
      headers: BEARER,
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("project_exists");
  });

  it("400s a body missing repoOwner or with a bad visibility (Zod)", async () => {
    app = await buildTestApp(makeService());
    const { repoOwner, ...noOwner } = IMPORT_BODY;
    void repoOwner;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects/import",
          headers: BEARER,
          payload: noOwner,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects/import",
          headers: BEARER,
          payload: { ...IMPORT_BODY, visibility: "secret" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("401s without a bearer token", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/projects/import",
      payload: IMPORT_BODY,
    });
    expect(res.statusCode).toBe(401);
  });
});
