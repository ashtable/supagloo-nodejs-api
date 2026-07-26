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

  it("U-OA5: requireAuth's 401 bodies are UNCHANGED by the optionalAuth addition (regression guard)", async () => {
    app = await buildApp({ authService: fakeAuthService });

    const missing = await inject();
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      error: "unauthorized",
      message: "missing bearer token",
    });

    const invalid = await inject({ authorization: "Bearer garbage" });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({
      error: "unauthorized",
      message: "invalid or expired token",
    });
  });
});

// ---------------------------------------------------------------- optionalAuth (D2)

/**
 * `optionalAuth` exists for the public gallery (Task #39, plan D2): `GET /v1/gallery` is
 * unauthenticated but must still personalize `viewerHasUpvoted` when a session IS
 * present. It lives in THIS plugin, not a second one, because a second plugin would
 * re-run `decorateRequest("authUser", …)` — which Fastify throws on — and duplicate
 * `parseBearer`.
 *
 * Its contract is RESOLVE-IF-PRESENT, NEVER 401. A separate app builder is used so these
 * cases fail on their own rather than taking the five requireAuth tests above down with
 * them.
 */
async function buildOptionalApp(opts: {
  authService: any;
  onHandler?: () => void;
}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(bearerAuthPlugin, { authService: opts.authService });
  // The decorator's ABSENCE must be a loud failure, not a silent pass. Fastify treats
  // `{ preHandler: undefined }` as "no preHandler at all", so without this guard three of
  // the four cases below (no header / malformed header / invalid token) would go GREEN
  // against a plugin that never grew an `optionalAuth` — the anonymous outcome they assert
  // is exactly what an unhooked route produces.
  if (typeof (app as { optionalAuth?: unknown }).optionalAuth !== "function") {
    throw new Error(
      "bearerAuthPlugin does not decorate `optionalAuth` — the public gallery listing " +
        "(plan D2) needs a resolve-if-present, never-401 preHandler on this same plugin.",
    );
  }
  app.get("/public", { preHandler: app.optionalAuth }, async (req) => {
    opts.onHandler?.();
    return {
      userId: (req as any).authUser?.id ?? null,
      sessionId: (req as any).authSession?.id ?? null,
    };
  });
  await app.ready();
  return app;
}

describe("bearerAuthPlugin — optionalAuth", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  const inject = (headers: Record<string, string> = {}) =>
    app!.inject({ method: "GET", url: "/public", headers });

  it("U-OA1: with NO Authorization header the handler runs and authUser stays null", async () => {
    let ran = false;
    app = await buildOptionalApp({
      authService: fakeAuthService,
      onHandler: () => (ran = true),
    });
    const res = await inject();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: null, sessionId: null });
    expect(ran).toBe(true);
  });

  it("U-OA2: a MALFORMED header is ignored — the handler runs anonymously, and authenticate is never called", async () => {
    const seen: string[] = [];
    const recording = {
      authenticate: async (token: string) => {
        seen.push(token);
        return null;
      },
    };
    app = await buildOptionalApp({ authService: recording });

    for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer   ", "garbage"]) {
      const res = await inject({ authorization });
      expect(res.statusCode, authorization).toBe(200);
      expect(res.json(), authorization).toEqual({ userId: null, sessionId: null });
    }
    // No token could be parsed, so there was nothing to look up — a malformed header must
    // not cost a session query on every anonymous gallery page view.
    expect(seen).toEqual([]);
  });

  it("U-OA3: a VALID token resolves the user and the session, exactly as requireAuth does", async () => {
    app = await buildOptionalApp({ authService: fakeAuthService });
    const res = await inject({ authorization: "Bearer valid" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: "u1", sessionId: "s1" });
  });

  it("U-OA4: a PRESENT-BUT-INVALID token degrades to anonymous — the handler runs and NO 401 reply is sent", async () => {
    let ran = false;
    app = await buildOptionalApp({
      authService: fakeAuthService,
      onHandler: () => (ran = true),
    });

    const res = await inject({ authorization: "Bearer expired-or-forged" });

    // The reply must NOT have been hijacked by the preHandler: the handler itself ran and
    // produced the anonymous body. A stale session cookie forwarded by the BFF has to
    // yield a public gallery, not an error page — `GET /api/me` is the session-truth
    // endpoint, not this one.
    expect(ran).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: null, sessionId: null });
    expect(res.json().error).toBeUndefined();
  });
});
