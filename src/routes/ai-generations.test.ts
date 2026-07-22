import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerAiGenerationRoutes } from "./ai-generations";
import {
  AiGenerationNotFoundError,
  GenerationNotCancelableError,
  KindProviderIncompatibleError,
  UnsupportedGenerationKindError,
} from "../ai/errors";
import { ProjectNotFoundError } from "../projects/errors";

// Thin-handler wiring for the Task #31 AI-generation endpoints (design-delta §2.8/§8).
// Isolated from the DB with a FAKE service + FAKE auth, driven via app.inject. Asserts
// the status-code map: 201 create / 400 bad body (Zod) / 401 no bearer / 422 matrix /
// 501 unwired-kind / 404 foreign-project; GET/:id + list 200/404/401; cancel 200/409/404.

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

const DTO = {
  id: "gen-1",
  projectId: "proj-1",
  sceneId: null,
  kind: "storyboard" as const,
  provider: "openrouter" as const,
  model: "openai/gpt-4o",
  status: "queued" as const,
  resultJson: null,
  resultAssetKey: null,
  error: null,
  tokenUsage: null,
  createdAt: new Date().toISOString(),
  completedAt: null,
};

function makeService(overrides: Record<string, any> = {}) {
  return {
    createGeneration: async () => ({ generationId: "gen-1" }),
    getGeneration: async () => ({ ...ROW }),
    listProjectGenerations: async () => [{ ...ROW }],
    cancelGeneration: async () => ({ ...ROW, status: "canceled", completedAt: new Date() }),
    ...overrides,
  } as any;
}

// A persisted-row-shaped object the fake service returns; the route maps it via
// toAiGenerationDto, so it needs Date objects for createdAt/completedAt.
const ROW = {
  id: "gen-1",
  projectId: "proj-1",
  sceneId: null,
  kind: "storyboard",
  provider: "openrouter",
  model: "openai/gpt-4o",
  status: "queued",
  resultJson: null,
  resultAssetKey: null,
  error: null,
  tokenUsage: null,
  createdAt: new Date(),
  completedAt: null,
};

async function buildTestApp(service: any): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(bearerAuthPlugin, { authService: fakeAuthService as any });
  registerAiGenerationRoutes(app, { service });
  await app.ready();
  return app;
}

const BEARER = { authorization: "Bearer valid" };
const CREATE_BODY = {
  kind: "storyboard",
  provider: "openrouter",
  model: "openai/gpt-4o",
  projectId: "proj-1",
  input: { brief: "Psalm 121" },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /ai/generations", () => {
  it("201s with { generationId } on success", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/ai/generations",
      headers: BEARER,
      payload: CREATE_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ generationId: "gen-1" });
  });

  it("passes the caller id + request through to the service", async () => {
    let seen: any;
    app = await buildTestApp(
      makeService({
        createGeneration: async (userId: string, req: unknown) => {
          seen = { userId, req };
          return { generationId: "gen-1" };
        },
      }),
    );
    await app.inject({
      method: "POST",
      url: "/ai/generations",
      headers: BEARER,
      payload: CREATE_BODY,
    });
    expect(seen.userId).toBe("u1");
    expect(seen.req).toMatchObject({ kind: "storyboard", provider: "openrouter" });
    expect(seen.req.input.brief).toBe("Psalm 121");
  });

  it("maps KindProviderIncompatibleError → 422 kind_provider_incompatible", async () => {
    app = await buildTestApp(
      makeService({
        createGeneration: async () => {
          throw new KindProviderIncompatibleError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/ai/generations",
      headers: BEARER,
      payload: {
        ...CREATE_BODY,
        kind: "image",
        provider: "gloo",
        input: { prompt: "x" },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("kind_provider_incompatible");
  });

  it("maps UnsupportedGenerationKindError → 501 generation_kind_unsupported", async () => {
    app = await buildTestApp(
      makeService({
        createGeneration: async () => {
          throw new UnsupportedGenerationKindError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/ai/generations",
      headers: BEARER,
      // `video` is the last matrix-valid-but-unwired kind (narration/music wired in #33); its
      // input is still the passthrough placeholder, so `{}` passes the boundary and reaches
      // the (mocked) service that throws the 501.
      payload: {
        ...CREATE_BODY,
        kind: "video",
        provider: "openrouter",
        input: {},
      },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe("generation_kind_unsupported");
  });

  it("maps ProjectNotFoundError → 404 not_found", async () => {
    app = await buildTestApp(
      makeService({
        createGeneration: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/ai/generations",
      headers: BEARER,
      payload: CREATE_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("400s a malformed body (unknown kind / bad input) via Zod", async () => {
    app = await buildTestApp(makeService());
    // storyboard input missing the required brief.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/ai/generations",
          headers: BEARER,
          payload: { ...CREATE_BODY, input: {} },
        })
      ).statusCode,
    ).toBe(400);
    // unknown kind.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/ai/generations",
          headers: BEARER,
          payload: { ...CREATE_BODY, kind: "hologram" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("401s without a bearer token", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/ai/generations",
      payload: CREATE_BODY,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /ai/generations/:id", () => {
  it("200s with { generation } DTO", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "GET",
      url: "/ai/generations/gen-1",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().generation.id).toBe("gen-1");
    expect(res.json().generation.kind).toBe("storyboard");
  });

  it("maps AiGenerationNotFoundError → 404 not_found", async () => {
    app = await buildTestApp(
      makeService({
        getGeneration: async () => {
          throw new AiGenerationNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/ai/generations/nope",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("401s without a bearer token", async () => {
    app = await buildTestApp(makeService());
    expect(
      (await app.inject({ method: "GET", url: "/ai/generations/gen-1" })).statusCode,
    ).toBe(401);
  });
});

describe("GET /projects/:id/generations", () => {
  it("200s with { generations } list", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "GET",
      url: "/projects/proj-1/generations",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().generations).toHaveLength(1);
    expect(res.json().generations[0].id).toBe("gen-1");
  });

  it("maps ProjectNotFoundError → 404 not_found", async () => {
    app = await buildTestApp(
      makeService({
        listProjectGenerations: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/projects/nope/generations",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("401s without a bearer token", async () => {
    app = await buildTestApp(makeService());
    expect(
      (await app.inject({ method: "GET", url: "/projects/proj-1/generations" }))
        .statusCode,
    ).toBe(401);
  });
});

describe("POST /ai/generations/:id/cancel", () => {
  it("200s with the updated { generation }", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/ai/generations/gen-1/cancel",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().generation.status).toBe("canceled");
  });

  it("maps GenerationNotCancelableError → 409 generation_not_cancelable", async () => {
    app = await buildTestApp(
      makeService({
        cancelGeneration: async () => {
          throw new GenerationNotCancelableError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/ai/generations/gen-1/cancel",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("generation_not_cancelable");
  });

  it("maps AiGenerationNotFoundError → 404 not_found", async () => {
    app = await buildTestApp(
      makeService({
        cancelGeneration: async () => {
          throw new AiGenerationNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/ai/generations/nope/cancel",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("401s without a bearer token", async () => {
    app = await buildTestApp(makeService());
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/ai/generations/gen-1/cancel",
        })
      ).statusCode,
    ).toBe(401);
  });
});
