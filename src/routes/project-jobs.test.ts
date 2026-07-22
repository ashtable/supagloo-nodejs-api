import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerProjectJobRoutes } from "./project-jobs";
import {
  CommitManifestInvalidError,
  GitOpsInFlightError,
  NoWorkingVersionError,
  ProjectAlreadyExistsError,
} from "../jobs/errors";
import { GithubNotConnectedError } from "../connections/errors";
import { ProjectNotFoundError } from "../projects/errors";

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
    createCommitJob: async () => ({ jobId: "commit-j" }),
    createPublishJob: async () => ({ jobId: "publish-j" }),
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

const COMMIT_BODY = {
  manifest: {
    manifestVersion: 1,
    composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
    scenes: [
      {
        id: "s1",
        name: "Shelter",
        scriptText: "He who dwells in the shelter of the Most High.",
        reference: "Psalm 91:1",
        translation: "BSB",
        visualPrompt: "A traveler resting under a vast starlit desert sky",
        durationSeconds: 5,
        captions: true,
      },
    ],
    narratorVoice: { description: "Warm, reverent male narrator" },
  },
  message: "Tighten the shelter scene pacing",
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

describe("POST /projects/:id/commit (Task #21)", () => {
  it("201s with { jobId } on success", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/projects/cprj1/commit",
      headers: BEARER,
      payload: COMMIT_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ jobId: "commit-j" });
  });

  it("passes the owner id, project id, and request through to the service", async () => {
    let seen: any;
    app = await buildTestApp(
      makeService({
        createCommitJob: async (userId: string, projectId: string, req: unknown) => {
          seen = { userId, projectId, req };
          return { jobId: "commit-j" };
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/projects/cprj1/commit",
      headers: BEARER,
      payload: COMMIT_BODY,
    });
    expect(seen.userId).toBe("u1");
    expect(seen.projectId).toBe("cprj1");
    expect(seen.req.message).toBe("Tighten the shelter scene pacing");
    expect(seen.req.manifest.scenes[0].name).toBe("Shelter");
  });

  it("maps ProjectNotFoundError → 404 not_found", async () => {
    app = await buildTestApp(
      makeService({
        createCommitJob: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/cprj1/commit",
      headers: BEARER,
      payload: COMMIT_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("maps GithubNotConnectedError → 409 github_not_connected", async () => {
    app = await buildTestApp(
      makeService({
        createCommitJob: async () => {
          throw new GithubNotConnectedError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/cprj1/commit",
      headers: BEARER,
      payload: COMMIT_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("github_not_connected");
  });

  it("maps GitOpsInFlightError → 409 git_ops_in_flight", async () => {
    app = await buildTestApp(
      makeService({
        createCommitJob: async () => {
          throw new GitOpsInFlightError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/cprj1/commit",
      headers: BEARER,
      payload: COMMIT_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("git_ops_in_flight");
  });

  it("maps NoWorkingVersionError → 409 no_working_version", async () => {
    app = await buildTestApp(
      makeService({
        createCommitJob: async () => {
          throw new NoWorkingVersionError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/cprj1/commit",
      headers: BEARER,
      payload: COMMIT_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_working_version");
  });

  it("maps CommitManifestInvalidError → 422 manifest_invalid", async () => {
    app = await buildTestApp(
      makeService({
        createCommitJob: async () => {
          throw new CommitManifestInvalidError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/cprj1/commit",
      headers: BEARER,
      payload: COMMIT_BODY,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("manifest_invalid");
  });

  it("400s a structurally-invalid manifest body (missing message / empty translation) via Zod", async () => {
    app = await buildTestApp(makeService());
    const { message, ...noMessage } = COMMIT_BODY;
    void message;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects/cprj1/commit",
          headers: BEARER,
          payload: noMessage,
        })
      ).statusCode,
    ).toBe(400);

    // TranslationSchema was broadened at task #30 (§9-Q10) to any non-empty string, so
    // "NIV" is now accepted; an EMPTY translation is still a Zod 400.
    const emptyTranslationBody = {
      ...COMMIT_BODY,
      manifest: {
        ...COMMIT_BODY.manifest,
        scenes: [{ ...COMMIT_BODY.manifest.scenes[0], translation: "" }],
      },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects/cprj1/commit",
          headers: BEARER,
          payload: emptyTranslationBody,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("401s without a bearer token", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/projects/cprj1/commit",
      payload: COMMIT_BODY,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /projects/:id/publish (Task #22)", () => {
  const PUBLISH_BODY = { message: "Publish the shelter cut" };

  it("201s with { jobId } on success", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/projects/pprj1/publish",
      headers: BEARER,
      payload: PUBLISH_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ jobId: "publish-j" });
  });

  it("passes the owner id, project id, and message through to the service", async () => {
    let seen: any;
    app = await buildTestApp(
      makeService({
        createPublishJob: async (userId: string, projectId: string, req: unknown) => {
          seen = { userId, projectId, req };
          return { jobId: "publish-j" };
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/projects/pprj1/publish",
      headers: BEARER,
      payload: PUBLISH_BODY,
    });
    expect(seen.userId).toBe("u1");
    expect(seen.projectId).toBe("pprj1");
    expect(seen.req.message).toBe("Publish the shelter cut");
  });

  it("maps ProjectNotFoundError → 404 not_found", async () => {
    app = await buildTestApp(
      makeService({
        createPublishJob: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/pprj1/publish",
      headers: BEARER,
      payload: PUBLISH_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("maps GithubNotConnectedError → 409 github_not_connected", async () => {
    app = await buildTestApp(
      makeService({
        createPublishJob: async () => {
          throw new GithubNotConnectedError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/pprj1/publish",
      headers: BEARER,
      payload: PUBLISH_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("github_not_connected");
  });

  it("maps GitOpsInFlightError → 409 git_ops_in_flight", async () => {
    app = await buildTestApp(
      makeService({
        createPublishJob: async () => {
          throw new GitOpsInFlightError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/pprj1/publish",
      headers: BEARER,
      payload: PUBLISH_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("git_ops_in_flight");
  });

  it("maps NoWorkingVersionError → 409 no_working_version", async () => {
    app = await buildTestApp(
      makeService({
        createPublishJob: async () => {
          throw new NoWorkingVersionError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/pprj1/publish",
      headers: BEARER,
      payload: PUBLISH_BODY,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_working_version");
  });

  it("400s an empty or missing message (Zod)", async () => {
    app = await buildTestApp(makeService());
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects/pprj1/publish",
          headers: BEARER,
          payload: { message: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects/pprj1/publish",
          headers: BEARER,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });

  it("401s without a bearer token", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/projects/pprj1/publish",
      payload: PUBLISH_BODY,
    });
    expect(res.statusCode).toBe(401);
  });
});
