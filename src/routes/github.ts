import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  GithubAuthorizeUrlQuerySchema,
  GithubAuthorizeUrlResponseSchema,
  GithubCallbackRequestSchema,
  GithubConnectionResponseSchema,
  GithubDisconnectResponseSchema,
  GithubInstallUrlResponseSchema,
  GithubLinkExistingRequestSchema,
  GithubRepoFilterSchema,
  GithubRepoListResponseSchema,
} from "@supagloo/database-lib";
import type { GithubConnectionService } from "../connections/github-connection-service";
import {
  AmbiguousUserInstallationError,
  GithubNotConnectedError,
  InstallationVerificationError,
  NoUserInstallationError,
} from "../connections/errors";
import { GithubUserAuthExchangeError } from "../connections/github-user-auth-client";
import {
  GITHUB_UPSTREAM_ERROR_SLUG,
  GITHUB_UPSTREAM_STATUS,
  isUpstreamGithubError,
} from "../connections/github-app-client";
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

  // ---- linking an installation the user ALREADY has ------------------------
  // The install callback only fires when an installation is CREATED, so these two
  // are the only path for a reinstall, an install made from GitHub's directory, or
  // one App registration shared across environments.
  r.get(
    "/connections/github/authorize-url",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: GithubAuthorizeUrlQuerySchema,
        response: {
          200: GithubAuthorizeUrlResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => ({
      url: service.authorizeUrl({
        redirectUri: req.query.redirectUri,
        state: req.query.state,
      }),
    }),
  );

  r.post(
    "/connections/github/link-existing",
    {
      preHandler: app.requireAuth,
      schema: {
        body: GithubLinkExistingRequestSchema,
        response: {
          200: GithubConnectionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const connection = await service.linkExisting(
          req.authUser!.id,
          req.body.code,
        );
        return { connection: toGithubConnectionDto(connection) };
      } catch (err) {
        // "You have no installation" and "several match" are both account STATE the
        // caller resolves by visiting the picker — not malformed input, and not our
        // outage. They carry distinct slugs so the UI can say which.
        if (err instanceof NoUserInstallationError) {
          return reply
            .code(err.statusCode)
            .send({ error: "no_installation", message: err.message });
        }
        if (err instanceof AmbiguousUserInstallationError) {
          return reply
            .code(err.statusCode)
            .send({ error: "ambiguous_installation", message: err.message });
        }
        if (err instanceof InstallationVerificationError) {
          return reply
            .code(400)
            .send({ error: "invalid_installation", message: err.message });
        }
        if (err instanceof GithubUserAuthExchangeError) {
          return reply
            .code(400)
            .send({ error: "invalid_code", message: err.message });
        }
        if (isUpstreamGithubError(err)) {
          return reply
            .code(GITHUB_UPSTREAM_STATUS)
            .send({ error: GITHUB_UPSTREAM_ERROR_SLUG, message: err.message });
        }
        throw err;
      }
    },
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
          502: errorResponseSchema,
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
        // GitHub itself failed (a non-2xx on the App-JWT verify). NOT the caller's
        // fault and NOT the caller's status — see `isUpstreamGithubError`.
        if (isUpstreamGithubError(err)) {
          return reply
            .code(GITHUB_UPSTREAM_STATUS)
            .send({ error: GITHUB_UPSTREAM_ERROR_SLUG, message: err.message });
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
 *
 * **This route is not only the repo picker.** The web client's `SessionProvider`
 * calls it on every hard page load of every page to render an "N repos accessible"
 * count, so its cost is a per-page-load cost for every connected user. The query is
 * therefore also a REQUEST BUDGET: `GithubConnectionService.listRepos` derives from
 * `filter`/`q` whether plan row 65's per-repo emptiness probe is worth issuing at
 * all (deferred review finding DR2). Widening what this route asks for widens what
 * every page load pays.
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
          502: errorResponseSchema,
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
        // This route reaches GitHub TWICE — db-lib's `mintInstallationToken` and the
        // paginated listing walk — and each throws its own error class. Both mean
        // "GitHub failed", and neither may set our status: an upstream 401 replied as
        // a 401 is read by the web client as an expired session, so an infrastructure
        // fault would log the user out. See `isUpstreamGithubError`.
        if (isUpstreamGithubError(err)) {
          return reply
            .code(GITHUB_UPSTREAM_STATUS)
            .send({ error: GITHUB_UPSTREAM_ERROR_SLUG, message: err.message });
        }
        throw err;
      }
    },
  );
}
