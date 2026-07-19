import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  GithubCallbackRequestSchema,
  GithubConnectionResponseSchema,
  GithubDisconnectResponseSchema,
  GithubInstallUrlResponseSchema,
  GithubRepoFilterSchema,
  GithubRepoListResponseSchema,
} from "@supagloo/database-lib";
import type { GithubConnectionService } from "../connections/github-connection-service";
import {
  GithubNotConnectedError,
  InstallationVerificationError,
} from "../connections/errors";
import { toGithubConnectionDto } from "../connections/dto";
import { errorResponseSchema } from "./auth";

export interface GithubRoutesDeps {
  service: GithubConnectionService;
}

/** Query for the live repo listing: a CLOSED `empty|all` filter (default `all`)
 *  plus optional free-text `q`. */
const reposQuerySchema = z.object({
  filter: GithubRepoFilterSchema.default("all"),
  q: z.string().optional(),
});

/**
 * GitHub App connection routes (design-delta §6a/§8), on the `/v1`-scoped
 * instance. All require a bearer session (`app.requireAuth`) — these are per-user
 * routes. install-url makes no network call; callback verifies via an App JWT
 * before storing; disconnect is idempotent.
 */
export function registerGithubConnectionRoutes(
  app: FastifyInstance,
  deps: GithubRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/connections/github/install-url",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: GithubInstallUrlResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async () => ({ url: service.installUrl() }),
  );

  r.post(
    "/connections/github/callback",
    {
      preHandler: app.requireAuth,
      schema: {
        body: GithubCallbackRequestSchema,
        response: {
          200: GithubConnectionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const connection = await service.connectFromCallback(
          req.authUser!.id,
          req.body.installationId,
        );
        return { connection: toGithubConnectionDto(connection) };
      } catch (err) {
        if (err instanceof InstallationVerificationError) {
          return reply
            .code(400)
            .send({ error: "invalid_installation", message: err.message });
        }
        throw err;
      }
    },
  );

  r.delete(
    "/connections/github",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: GithubDisconnectResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      await service.disconnect(req.authUser!.id);
      return { ok: true as const };
    },
  );
}

/**
 * Live GitHub repo listing (design-delta §8) — mints a fresh installation token
 * per request (never cached/stored). Bearer-protected; 409 if the user has no
 * GitHub connection.
 */
export function registerGithubRepoRoutes(
  app: FastifyInstance,
  deps: GithubRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/github/repos",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: reposQuerySchema,
        response: {
          200: GithubRepoListResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const repositories = await service.listRepos(req.authUser!.id, {
          filter: req.query.filter,
          q: req.query.q,
        });
        return { repositories };
      } catch (err) {
        if (err instanceof GithubNotConnectedError) {
          return reply
            .code(409)
            .send({ error: "github_not_connected", message: err.message });
        }
        throw err;
      }
    },
  );
}
