import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerRenderRoutes } from "./renders";
import {
  RenderNotCancelableError,
  RenderNotFoundError,
} from "../renders/errors";
import { ProjectNotFoundError } from "../projects/errors";

// Thin-handler wiring for the Task #37 render endpoints (design-delta §2.7/§6c/§8).
// Isolated from the DB with a FAKE service + FAKE auth, driven via app.inject. Asserts
// the status-code map: 201 create / 400 bad body + missing `mine` (Zod) / 401 no bearer /
// 404 uniform denial (foreign project, foreign render, output not ready) /
// 409 render_not_cancelable.

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

/** A persisted-row-shaped object the fake service returns; the route maps it via
 *  toRenderJobDto, so it needs Date objects. */
const ROW = {
  id: "render-1",
  projectId: "proj-1",
  versionId: "ver-1",
  userId: "u1",
  status: "encoding",
  framesDone: 612,
  framesTotal: 840,
  width: 1080,
  height: 1920,
  fps: 30,
  aspectRatio: "9:16",
  codec: "h264",
  outputAssetKey: null,
  thumbnailAssetKey: null,
  runInBackground: false,
  error: null,
  createdAt: new Date("2026-07-24T10:00:00.000Z"),
  startedAt: new Date("2026-07-24T10:00:05.000Z"),
  completedAt: null,
};

const EXPIRES = new Date("2026-07-24T10:05:00.000Z");

function makeService(overrides: Record<string, any> = {}) {
  return {
    createRender: async () => ({ renderJobId: "render-1" }),
    getRender: async () => ({ ...ROW }),
    listMyRenders: async () => [{ ...ROW }],
    cancelRender: async () => ({ ...ROW, status: "canceled", completedAt: new Date() }),
    presignRenderDownload: async () => ({
      url: "https://s3.test/renders/render-1/output.mp4?sig=1",
      expiresAt: EXPIRES,
    }),
    ...overrides,
  } as any;
}

async function buildTestApp(service: any): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(bearerAuthPlugin, { authService: fakeAuthService as any });
  registerRenderRoutes(app, { service });
  await app.ready();
  return app;
}

const BEARER = { authorization: "Bearer valid" };
const CREATE_BODY = {
  versionId: "ver-1",
  outputSpec: {
    width: 1080,
    height: 1920,
    fps: 30,
    aspectRatio: "9:16",
    codec: "h264",
  },
  runInBackground: false,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe("render routes — auth", () => {
  it("U-RR1: every route 401s without a bearer token", async () => {
    app = await buildTestApp(makeService());
    const calls = [
      app.inject({ method: "POST", url: "/projects/proj-1/renders", payload: CREATE_BODY }),
      app.inject({ method: "GET", url: "/renders/render-1" }),
      app.inject({ method: "POST", url: "/renders/render-1/cancel" }),
      app.inject({ method: "GET", url: "/renders?mine=1" }),
      app.inject({ method: "GET", url: "/renders/render-1/download" }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("POST /projects/:id/renders", () => {
  it("U-RR2: 201 { renderJobId } on success", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/projects/proj-1/renders",
      headers: BEARER,
      payload: CREATE_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ renderJobId: "render-1" });
  });

  it("U-RR2b: a malformed outputSpec is rejected at the Zod boundary (400) and never reaches the service", async () => {
    let called = false;
    app = await buildTestApp(
      makeService({
        createRender: async () => {
          called = true;
          return { renderJobId: "render-1" };
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/proj-1/renders",
      headers: BEARER,
      payload: { ...CREATE_BODY, outputSpec: { ...CREATE_BODY.outputSpec, aspectRatio: "9-16" } },
    });
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
  });

  it("U-RR3: a foreign/unknown project or version 404s as `not_found`", async () => {
    app = await buildTestApp(
      makeService({
        createRender: async () => {
          throw new ProjectNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/projects/proj-1/renders",
      headers: BEARER,
      payload: CREATE_BODY,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});

describe("GET /renders/:id", () => {
  it("U-RR3b: 200 with the keyed { render } envelope and the re-nested outputSpec", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "GET",
      url: "/renders/render-1",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.render.id).toBe("render-1");
    expect(body.render.outputSpec).toEqual(CREATE_BODY.outputSpec);
    expect(body.render.userId).toBeUndefined();
  });

  it("U-RR3c: an unknown / foreign render 404s with the same body as a missing project", async () => {
    app = await buildTestApp(
      makeService({
        getRender: async () => {
          throw new RenderNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/renders/nope",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});

describe("POST /renders/:id/cancel", () => {
  it("U-RR4a: 200 with the updated render", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "POST",
      url: "/renders/render-1/cancel",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().render.status).toBe("canceled");
  });

  it("U-RR4: a terminal render 409s with render_not_cancelable", async () => {
    app = await buildTestApp(
      makeService({
        cancelRender: async () => {
          throw new RenderNotCancelableError();
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/renders/render-1/cancel",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("render_not_cancelable");
  });
});

describe("GET /renders?mine=1", () => {
  it("U-RR5: without `mine` the request is rejected (400) — there is no cross-user listing", async () => {
    let called = false;
    app = await buildTestApp(
      makeService({
        listMyRenders: async () => {
          called = true;
          return [];
        },
      }),
    );
    for (const url of ["/renders", "/renders?mine=0", "/renders?mine=true"]) {
      const res = await app.inject({ method: "GET", url, headers: BEARER });
      expect(res.statusCode, url).toBe(400);
    }
    expect(called).toBe(false);
  });

  it("U-RR5b: with mine=1 → 200 { renders: [...] } keyed envelope", async () => {
    app = await buildTestApp(makeService({ listMyRenders: async () => [{ ...ROW }] }));
    const res = await app.inject({
      method: "GET",
      url: "/renders?mine=1",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.renders)).toBe(true);
    expect(body.renders[0].id).toBe("render-1");
  });
});

describe("GET /renders/:id/download", () => {
  it("U-RR6: 200 { url, expiresAt } with expiresAt ISO-stringified", async () => {
    app = await buildTestApp(makeService());
    const res = await app.inject({
      method: "GET",
      url: "/renders/render-1/download",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: "https://s3.test/renders/render-1/output.mp4?sig=1",
      expiresAt: EXPIRES.toISOString(),
    });
  });

  it("U-RR6b: a render whose output is not ready 404s (D9 — a GET for a nonexistent object is a 404, not a 409)", async () => {
    app = await buildTestApp(
      makeService({
        presignRenderDownload: async () => {
          throw new RenderNotFoundError();
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/renders/render-1/download",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});
