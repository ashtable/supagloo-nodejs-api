import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { bearerAuthPlugin } from "./bearer-auth";

// The bearer-auth Fastify plugin (design-delta §8). Tested against a FAKE auth
// service so this file isolates the plugin's HTTP behaviour: parse the header,
// delegate to authenticate(), 401 on anything missing/garbage/expired, and
// expose the authenticated user on the request for protected handlers.
const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid"
      ? { user: { id: "u1" }, session: { id: "s1" } }
      : null,
};

async function buildApp(opts: { authService: any }): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(bearerAuthPlugin, { authService: opts.authService });
  app.get(
    "/protected",
    { preHandler: app.requireAuth },
    async (req) => ({ userId: (req as any).authUser?.id ?? null }),
  );
  await app.ready();
  return app;
}

describe("bearerAuthPlugin", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  const inject = (headers: Record<string, string> = {}) =>
    app!.inject({ method: "GET", url: "/protected", headers });

  it("401s a request with no Authorization header", async () => {
    app = await buildApp({ authService: fakeAuthService });
    const res = await inject();
    expect(res.statusCode).toBe(401);
  });

  it("401s a non-Bearer scheme", async () => {
    app = await buildApp({ authService: fakeAuthService });
    const res = await inject({ authorization: "Basic dXNlcjpwYXNz" });
    expect(res.statusCode).toBe(401);
  });

  it("401s a Bearer header with no token", async () => {
    app = await buildApp({ authService: fakeAuthService });
    const res = await inject({ authorization: "Bearer" });
    expect(res.statusCode).toBe(401);
    const res2 = await inject({ authorization: "Bearer   " });
    expect(res2.statusCode).toBe(401);
  });

  it("401s a garbage/expired token (authenticate returns null)", async () => {
    app = await buildApp({ authService: fakeAuthService });
    const res = await inject({ authorization: "Bearer garbage" });
    expect(res.statusCode).toBe(401);
  });

  it("passes a valid token through and exposes the user on the request", async () => {
    app = await buildApp({ authService: fakeAuthService });
    const res = await inject({ authorization: "Bearer valid" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: "u1" });
  });
});
