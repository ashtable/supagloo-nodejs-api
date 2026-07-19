import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerHealthRoutes } from "./routes/health";
import { bearerAuthPlugin } from "./auth/bearer-auth";
import { registerAuthRoutes } from "./routes/auth";
import { registerTestSeedRoute } from "./routes/test-seed";
import type { AuthService } from "./auth/auth-service";

/** Dependencies needed to serve the `/v1` auth + session surface. Supplied by
 *  `server.ts` (real Prisma-backed service) and by the e2e harness. When omitted,
 *  only the public health route is registered (keeps `buildApp()` usable in the
 *  health-only unit/e2e tests). */
export interface AuthDeps {
  authService: AuthService;
  /** Only the seed-gate fields are needed here (§9-Q9). */
  env: {
    NODE_ENV: "development" | "test" | "production";
    SUPAGLOO_ENABLE_TEST_SEED?: string;
  };
}

export interface BuildAppOptions {
  /** Enable Fastify's request logger (on for the running server, off in tests). */
  logger?: boolean;
  /** Wire the `/v1` auth/session routes. Omit for a health-only app. */
  auth?: AuthDeps;
}

/**
 * Construct the Fastify application with the shared Zod type provider wired as
 * the validator + serializer (design-delta §2.11 — API DTO schemas are Zod,
 * shared with the Next.js BFF for end-to-end type safety). Returned un-listened
 * so tests can `inject` or `listen` on an ephemeral port.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerHealthRoutes(app);

  const auth = options.auth;
  if (auth) {
    // Everything versioned lives under `/v1` (design-delta §8). The bearer plugin
    // is registered inside this scope so `requireAuth` is available to the routes.
    app.register(
      async (v1) => {
        await v1.register(bearerAuthPlugin, {
          authService: auth.authService,
        });
        registerAuthRoutes(v1, { authService: auth.authService });
        registerTestSeedRoute(v1, {
          authService: auth.authService,
          env: auth.env,
        });
      },
      { prefix: "/v1" },
    );
  }

  return app;
}
