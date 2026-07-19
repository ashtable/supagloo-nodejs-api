import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerFileRoutes } from "./files";
import { FileAccessDeniedError } from "../files/errors";

// Thin-handler wiring for the presigned-download route (Task #13, design-delta
// §4/§8). Isolated from S3/DB with a FAKE service + FAKE auth, driven via
// app.inject. The route requires the bearer session; FileAccessDeniedError maps to
// 404; a missing `key` query is a 400 (Fastify validation).

const PRESIGNED = {
  url: "http://localhost:9000/supagloo-dev/projects/p1/assets/a1?X-Amz-Signature=abc",
  expiresAt: new Date("2026-07-18T00:05:00.000Z"),
};

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

function makeDeps(overrides: { service?: Record<string, any> } = {}) {
  return {
    service: {
      presignDownload: async () => PRESIGNED,
      ...overrides.service,
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
  registerFileRoutes(app, deps);
  await app.ready();
  return app;
}

const BEARER = { authorization: "Bearer valid" };

describe("File routes — presign-download", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("401s without a bearer token", async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "GET",
      url: "/files/presign-download?key=projects/p1/assets/a1",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns { url, expiresAt } for an owned key, passing userId + key through", async () => {
    let seen: { userId?: string; key?: string } = {};
    app = await buildApp(
      makeDeps({
        service: {
          presignDownload: async (userId: string, key: string) => {
            seen = { userId, key };
            return PRESIGNED;
          },
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/files/presign-download?key=projects/p1/assets/a1",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ userId: "u1", key: "projects/p1/assets/a1" });
    expect(res.json()).toEqual({
      url: PRESIGNED.url,
      expiresAt: "2026-07-18T00:05:00.000Z",
    });
  });

  it("maps FileAccessDeniedError to 404 (foreign / unknown / malformed all look the same)", async () => {
    app = await buildApp(
      makeDeps({
        service: {
          presignDownload: async () => {
            throw new FileAccessDeniedError();
          },
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/files/presign-download?key=projects/other/assets/a1",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a request with no key query param", async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "GET",
      url: "/files/presign-download",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(400);
  });
});
