import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerTestSeedRoute } from "./test-seed";

// The flag-gated seed endpoint (design-delta §9-Q9). It must HARD-404 — behave as
// if the route does not exist — unless BOTH NODE_ENV !== 'production' AND
// SUPAGLOO_ENABLE_TEST_SEED === '1'. Implemented by NOT registering the route
// when the gate fails, so Fastify's own not-found handler answers (a true 404,
// not a 401/403 that would leak the route's existence).

const fullUser = {
  id: "u1",
  youversionUserId: "yv-seed-1",
  displayName: "Seed One",
  email: "seed1@example.test",
  avatarInitials: "SO",
  firstSignInAt: new Date("2026-07-18T00:00:00.000Z"),
  onboardingCompletedAt: null,
  lastSeenAt: new Date("2026-07-18T00:00:00.000Z"),
  createdAt: new Date("2026-07-18T00:00:00.000Z"),
  updatedAt: new Date("2026-07-18T00:00:00.000Z"),
};

const fakeAuthService = {
  seed: async () => ({ users: [{ user: fullUser, token: "seed-token-1" }] }),
} as any;

async function buildSeedApp(env: {
  NODE_ENV: "development" | "test" | "production";
  SUPAGLOO_ENABLE_TEST_SEED?: string;
}): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerTestSeedRoute(app, { authService: fakeAuthService, env });
  await app.ready();
  return app;
}

const validBody = {
  users: [
    {
      youversionUserId: "yv-seed-1",
      displayName: "Seed One",
      email: "seed1@example.test",
      avatarInitials: "SO",
      sessionToken: "seed-token-1",
    },
  ],
};

describe("POST /test/seed — double-gate hard-404 (§9-Q9)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  const post = () =>
    app!.inject({ method: "POST", url: "/test/seed", payload: validBody });

  it("404s in non-prod when the flag is UNSET (flag off ⇒ 404 even in non-prod)", async () => {
    app = await buildSeedApp({ NODE_ENV: "test" });
    const res = await post();
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Not Found");
  });

  it("404s in development when the flag is UNSET", async () => {
    app = await buildSeedApp({ NODE_ENV: "development" });
    expect((await post()).statusCode).toBe(404);
  });

  it("404s in PRODUCTION even when the flag is '1' (prod ⇒ 404 regardless)", async () => {
    app = await buildSeedApp({
      NODE_ENV: "production",
      SUPAGLOO_ENABLE_TEST_SEED: "1",
    });
    expect((await post()).statusCode).toBe(404);
  });

  it("registers and seeds when BOTH gates pass (non-prod + flag '1')", async () => {
    app = await buildSeedApp({
      NODE_ENV: "test",
      SUPAGLOO_ENABLE_TEST_SEED: "1",
    });
    const res = await post();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users[0].token).toBe("seed-token-1");
    expect(body.users[0].user.youversionUserId).toBe("yv-seed-1");
  });
});
