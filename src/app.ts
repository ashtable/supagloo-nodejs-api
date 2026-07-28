import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerErrorHandler } from "./error-handler";
import { buildLoggerOptions } from "./logging/redact";
import { registerHealthRoutes } from "./routes/health";
import { bearerAuthPlugin } from "./auth/bearer-auth";
import { registerAuthRoutes } from "./routes/auth";
import { registerTestSeedRoute } from "./routes/test-seed";
import {
  registerTestGithubOauthRoute,
  type TestGithubOauthDeps,
} from "./routes/test-github-oauth";
import {
  registerGithubConnectionRoutes,
  registerGithubRepoRoutes,
} from "./routes/github";
import { registerConnectionRoutes } from "./routes/connections";
import { registerFileRoutes } from "./routes/files";
import { registerProjectRoutes } from "./routes/projects";
import { registerManifestRoutes } from "./routes/manifests";
import { registerProjectJobRoutes } from "./routes/project-jobs";
import { registerAiGenerationRoutes } from "./routes/ai-generations";
import { registerAiModelRoutes } from "./routes/ai-models";
import type { ModelCatalogueService } from "./ai/model-catalogue-service";
import { registerRepoProvisioningRoutes } from "./routes/repo-provisioning";
import { registerRenderRoutes } from "./routes/renders";
import { registerGalleryRoutes } from "./routes/gallery";
import type { AuthService } from "./auth/auth-service";
import type { GithubConnectionService } from "./connections/github-connection-service";
import type { OpenRouterConnectionService } from "./connections/openrouter-connection-service";
import type { GlooConnectionService } from "./connections/gloo-connection-service";
import type { ConnectionsService } from "./connections/connections-service";
import type { FilesService } from "./files/files-service";
import type { ProjectsService } from "./projects/projects-service";
import type { ManifestService } from "./manifests/manifest-service";
import type { ProjectJobsService } from "./jobs/project-jobs-service";
import type { AiGenerationsService } from "./ai/ai-generations-service";
import type { RepoProvisioningService } from "./projects/repo-provisioning-service";
import type { RendersService } from "./renders/renders-service";
import type { GalleryService } from "./gallery/gallery-service";

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

/**
 * Dependencies for the TEST-ONLY user-authorization token-exchange route (plan row
 * 66). A carrier of its OWN, deliberately: `AuthDeps.env` is the only place the two
 * gate values live today, and the whole `/v1` scope only exists when `auth` is
 * supplied — but this route registers OUTSIDE `/v1` (the client requests a fixed
 * unversioned `/login/oauth/access_token`), so inheriting that coupling would tie a
 * GitHub seam to whether the session surface happens to be wired.
 *
 * Aliased to the route's own dep type rather than re-declared, so the round-4 R5
 * addition (the App OAuth `client_id`/`client_secret` the route now verifies the
 * POSTed pair against) cannot be forgotten here and silently fail open.
 */
export type TestGithubOauthWiring = TestGithubOauthDeps;

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

/** Dependencies for the projects/versions read+mutate surface (design-delta §2.6/§8).
 *  Registered inside the same bearer-protected `/v1` scope as `auth`, so only wired
 *  when `auth` is supplied (the routes need `requireAuth`). */
export interface ProjectsDeps {
  service: ProjectsService;
}

/** Dependencies for the manifest-read surface (design-delta §5.3/§8). Registered inside
 *  the same bearer-protected `/v1` scope as `auth`, so only wired when `auth` is supplied
 *  (the route needs `requireAuth`). */
export interface ManifestsDeps {
  service: ManifestService;
}

/** Dependencies for the project create + job-polling surface (design-delta
 *  §5.1/§6b/§8). Registered inside the same bearer-protected `/v1` scope as `auth`, so
 *  only wired when `auth` is supplied (the routes need `requireAuth`). */
export interface ProjectJobsDeps {
  service: ProjectJobsService;
}

/** Dependencies for the AI-generation surface (design-delta §2.8/§7/§8). Registered
 *  inside the same bearer-protected `/v1` scope as `auth`, so only wired when `auth` is
 *  supplied (the routes need `requireAuth`). */
export interface AiGenerationsDeps {
  service: AiGenerationsService;
}

/** Dependencies for the create-new-repo JIT hop (design-delta §2.3/§6b/§8).
 *  Registered inside the same bearer-protected `/v1` scope as `auth`, so only wired
 *  when `auth` is supplied (the routes need `requireAuth`). */
export interface RepoProvisioningDeps {
  service: RepoProvisioningService;
}

/** Dependencies for the render surface (Task #37, design-delta §2.7/§6c/§8). Registered
 *  inside the same bearer-protected `/v1` scope as `auth`, so only wired when `auth` is
 *  supplied (the routes need `requireAuth`). */
export interface RendersDeps {
  service: RendersService;
}

/**
 * Dependencies for the gallery surface (Tasks #39 + #40, design-delta §2.7/§6c/§8).
 *
 * Registered inside the SAME `/v1` scope as everything else — design-delta §8 says all
 * routes live under `/v1`, and `bearerAuthPlugin` registers no instance-wide hook, so a
 * genuinely public route inside that scope needs no second scope and no unversioned
 * registration: it simply omits `preHandler` (or uses `app.optionalAuth`).
 *
 * It still requires `auth`, because that is what registers the bearer plugin whose
 * `requireAuth` / `optionalAuth` decorators these routes reference — and four of the seven
 * gallery routes DO need a session.
 */
export interface GalleryDeps {
  service: GalleryService;
}

export interface BuildAppOptions {
  /**
   * Enable Fastify's request logger (`true` for the running server, omitted in tests).
   *
   * Whatever is supplied here is MERGED ON TOP of {@link buildLoggerOptions}'s redaction
   * (plan row 43), never instead of it — pass a `level` or a destination `stream` without
   * having to remember to re-add the `err` serializer, the header path list and the `msg`
   * hook, and without being able to silently drop them.
   *
   * "Never instead of it" is enforced, not merely intended: `resolveLoggerOptions` merges
   * `redact.paths`, `serializers` and `hooks` sub-object by sub-object with row 43's entries
   * last, so a caller's own serializer or path list is ADDED alongside them. `U-RED-19` /
   * `U-RED-19b` hold it. (Before Step 11 this was a shallow spread, and the sentence above
   * was false: `{ logger: { serializers: { req } } }` removed the `err` serializer.)
   */
  logger?: FastifyServerOptions["logger"];
  /** Wire the `/v1` auth/session routes. Omit for a health-only app. */
  auth?: AuthDeps;
  /** Wire the `/v1` GitHub connection + repo routes. Requires `auth` (bearer). */
  github?: GithubDeps;
  /** Wire the `/v1` OpenRouter + Gloo + merged connection routes. Requires `auth`. */
  connections?: ConnectionsDeps;
  /** Wire the `/v1` S3 presigned-download route. Requires `auth` (bearer). */
  files?: FilesDeps;
  /** Wire the `/v1` projects/versions read+mutate routes. Requires `auth` (bearer). */
  projects?: ProjectsDeps;
  /** Wire the `/v1` manifest-read route. Requires `auth` (bearer). */
  manifests?: ManifestsDeps;
  /** Wire the `/v1` project create + job-polling routes. Requires `auth` (bearer). */
  projectJobs?: ProjectJobsDeps;
  /** Wire the `/v1` AI-generation routes. Requires `auth` (bearer). */
  aiGenerations?: AiGenerationsDeps;
  /** Wire `GET /v1/ai/models`, the live provider/model catalogue the studio Inspector's
   *  model selectors and cost estimate read. Requires `auth` (bearer) — the Gloo half is
   *  fetched with a token minted from the CALLER'S stored client credentials. */
  aiModels?: { service: ModelCatalogueService };
  /** Wire the `/v1` create-new-repo JIT hop routes. Requires `auth` (bearer). */
  repoProvisioning?: RepoProvisioningDeps;
  /** Wire the `/v1` render routes. Requires `auth` (bearer). */
  renders?: RendersDeps;
  /**
   * Wire the `/v1` gallery + upvote routes. Requires `auth` — not because every route needs
   * a bearer (three do not), but because `auth` is what registers the plugin providing the
   * `requireAuth` / `optionalAuth` decorators.
   */
  gallery?: GalleryDeps;
  /**
   * Wire the TEST-ONLY `POST /login/oauth/access_token` route (plan row 66).
   * Independent of `auth`: it lives OUTSIDE `/v1` and needs no bearer. Supplying this
   * is not the same as enabling it — the route still hard-404s (by never registering)
   * unless BOTH `NODE_ENV !== 'production'` and `SUPAGLOO_ENABLE_TEST_SEED === '1'`.
   */
  testGithubOauth?: TestGithubOauthWiring;
}

/**
 * Construct the Fastify application with the shared Zod type provider wired as
 * the validator + serializer (design-delta §2.11 — API DTO schemas are Zod,
 * shared with the Next.js BFF for end-to-end type safety). Returned un-listened
 * so tests can `inject` or `listen` on an ephemeral port.
 */
/**
 * Resolve `BuildAppOptions.logger` into what Fastify receives, folding in row 43's
 * redaction whenever logging is on at all.
 *
 * A logger instance (something with `.child`) is passed through untouched — it is already
 * configured and merging pino OPTIONS into it would be meaningless. Everything else is pino
 * options: `true` means "the redacting defaults", an object means "the redacting defaults,
 * plus these".
 *
 * THE MERGE IS DEEP, and that is the whole point of the sentence on
 * {@link BuildAppOptions.logger}. A shallow `{ ...base, ...logger }` let a caller passing
 * ANY serializer replace the `err` serializer wholesale, and a caller passing ANY `redact`
 * block replace the header path list — silently, which is exactly what that JSDoc promises
 * cannot happen. Each redaction sub-object is therefore spread with BASE'S ENTRIES LAST: a
 * caller may ADD a serializer, a path or a hook, and can never drop one of row 43's.
 */
function resolveLoggerOptions(
  logger: FastifyServerOptions["logger"],
): FastifyServerOptions["logger"] {
  if (!logger) return false;
  const base = buildLoggerOptions();
  if (logger === true) return base;
  if (typeof logger === "object" && !("child" in logger)) {
    const caller = logger as Record<string, unknown>;
    const asRecord = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};
    // pino accepts `redact` as either a bare path array or `{ paths, censor, remove }`.
    const callerRedact = caller.redact;
    const callerPaths = Array.isArray(callerRedact)
      ? (callerRedact as string[])
      : ((callerRedact as { paths?: string[] } | undefined)?.paths ?? []);
    const callerRedactRest = Array.isArray(callerRedact)
      ? {}
      : asRecord(callerRedact);
    return {
      ...base,
      ...caller,
      redact: {
        ...callerRedactRest,
        // Deduped: fast-redact throws on a duplicated path.
        paths: [...new Set([...callerPaths, ...base.redact.paths])],
        censor: base.redact.censor,
      },
      serializers: { ...asRecord(caller.serializers), ...base.serializers },
      hooks: { ...asRecord(caller.hooks), ...base.hooks },
    } as FastifyServerOptions["logger"];
  }
  return logger;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  // Redaction is applied HERE rather than at the one call site that enables logging, so a
  // future second caller (or an e2e that turns logging on to debug) cannot get an
  // unredacted logger by simply not knowing about it.
  const app = Fastify({ logger: resolveLoggerOptions(options.logger ?? false) });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // On the ROOT instance, so every scope inherits it — including `/v1`. DEFENCE IN DEPTH:
  // every intentional reply is sent explicitly by its route handler and never reaches it; what
  // it catches is the accidents, which until 2026-07-26 answered anonymous callers with the
  // Prisma error code, the SQLSTATE and the offending literal. See `error-handler.ts`.
  registerErrorHandler(app);

  registerHealthRoutes(app);

  // OUTSIDE the `/v1` scope, deliberately (plan row 66): `exchangeCode` requests a
  // fixed `${base}/login/oauth/access_token` — GitHub's own URL shape, with no
  // version prefix — so a `/v1`-scoped registration could never be reached.
  if (options.testGithubOauth) {
    registerTestGithubOauthRoute(app, { env: options.testGithubOauth.env });
  }

  const auth = options.auth;
  const github = options.github;
  const connections = options.connections;
  const files = options.files;
  const projects = options.projects;
  const manifests = options.manifests;
  const projectJobs = options.projectJobs;
  const aiGenerations = options.aiGenerations;
  const aiModels = options.aiModels;
  const repoProvisioning = options.repoProvisioning;
  const renders = options.renders;
  const gallery = options.gallery;
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
        if (projects) {
          registerProjectRoutes(v1, { service: projects.service });
        }
        if (manifests) {
          registerManifestRoutes(v1, { service: manifests.service });
        }
        if (projectJobs) {
          registerProjectJobRoutes(v1, { service: projectJobs.service });
        }
        if (aiGenerations) {
          registerAiGenerationRoutes(v1, { service: aiGenerations.service });
        }
        if (aiModels) {
          registerAiModelRoutes(v1, { service: aiModels.service });
        }
        if (repoProvisioning) {
          registerRepoProvisioningRoutes(v1, {
            service: repoProvisioning.service,
          });
        }
        if (renders) {
          registerRenderRoutes(v1, { service: renders.service });
        }
        if (gallery) {
          registerGalleryRoutes(v1, { service: gallery.service });
        }
      },
      { prefix: "/v1" },
    );
  }

  return app;
}
