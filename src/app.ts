import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerHealthRoutes } from "./routes/health";
import { bearerAuthPlugin } from "./auth/bearer-auth";
import { registerAuthRoutes } from "./routes/auth";
import { registerTestSeedRoute } from "./routes/test-seed";
import {
  registerGithubConnectionRoutes,
  registerGithubRepoRoutes,
} from "./routes/github";
import { registerConnectionRoutes } from "./routes/connections";
import { registerFileRoutes } from "./routes/files";
import type { AuthService } from "./auth/auth-service";
import type { GithubConnectionService } from "./connections/github-connection-service";
import type { OpenRouterConnectionService } from "./connections/openrouter-connection-service";
import type { GlooConnectionService } from "./connections/gloo-connection-service";
import type { ConnectionsService } from "./connections/connections-service";
import type { FilesService } from "./files/files-service";

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

/** Dependencies for the GitHub App connection surface (design-delta §2.3/§8).
 *  Registered inside the same bearer-protected `/v1` scope as `auth`, so it is
 *  only wired when `auth` is also supplied (its routes need `requireAuth`). */
export interface GithubDeps {
  service: GithubConnectionService;
}

/** Dependencies for the OpenRouter + Gloo connection surface + the merged
 *  `GET /v1/connections` (design-delta §2.5/§8). Registered inside the same
 *  bearer-protected `/v1` scope as `auth`, so only wired when `auth` is supplied. */
export interface ConnectionsDeps {
  openrouter: OpenRouterConnectionService;
  gloo: GlooConnectionService;
  /** Merged reader across all three connection tables (backs `GET /v1/connections`). */
  reader: ConnectionsService;
}

/** Dependencies for the S3 presigned-download surface (design-delta §4/§8).
 *  Registered inside the same bearer-protected `/v1` scope as `auth`, so only wired
 *  when `auth` is supplied (the route needs `requireAuth`). */
export interface FilesDeps {
  service: FilesService;
}

export interface BuildAppOptions {
  /** Enable Fastify's request logger (on for the running server, off in tests). */
  logger?: boolean;
  /** Wire the `/v1` auth/session routes. Omit for a health-only app. */
  auth?: AuthDeps;
  /** Wire the `/v1` GitHub connection + repo routes. Requires `auth` (bearer). */
  github?: GithubDeps;
  /** Wire the `/v1` OpenRouter + Gloo + merged connection routes. Requires `auth`. */
  connections?: ConnectionsDeps;
  /** Wire the `/v1` S3 presigned-download route. Requires `auth` (bearer). */
  files?: FilesDeps;
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
  const github = options.github;
  const connections = options.connections;
  const files = options.files;
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
        if (github) {
          registerGithubConnectionRoutes(v1, { service: github.service });
          registerGithubRepoRoutes(v1, { service: github.service });
        }
        if (connections) {
          registerConnectionRoutes(v1, {
            openrouter: connections.openrouter,
            gloo: connections.gloo,
            reader: connections.reader,
          });
        }
        if (files) {
          registerFileRoutes(v1, { service: files.service });
        }
      },
      { prefix: "/v1" },
    );
  }

  return app;
}
