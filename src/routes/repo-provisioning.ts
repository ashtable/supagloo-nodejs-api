import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateProjectResponseSchema,
  CreateRepoRequestSchema,
  RepoAuthorizeUrlQuerySchema,
  RepoAuthorizeUrlResponseSchema,
} from "@supagloo/database-lib";
import type { RepoProvisioningService } from "../projects/repo-provisioning-service";
import { RepoCreationError } from "../projects/repo-provisioning-errors";
import {
  GitOpsInFlightError,
  ProjectAlreadyExistsError,
} from "../jobs/errors";
import { GithubNotConnectedError } from "../connections/errors";
import { errorResponseSchema } from "./auth";

export interface RepoProvisioningRoutesDeps {
  service: RepoProvisioningService;
}

/**
 * Create-new-repo JIT hop routes (Task #26, design-delta §2.3/§6b/§8), on the
 * `/v1`-scoped instance. Both require a bearer session (`app.requireAuth`).
 *
 * `GET /projects/repo-authorize-url` returns the hosted GitHub user-authorization
 * URL the wizard opens (no network, no user secret crosses the wire).
 * `POST /projects/create-repo` runs the zero-storage user-token dance — exchange the
 * `code`, create the repo, add it to the installation, discard the token — then
 * delegates to the existing create-project+scaffold path, returning the SAME
 * `{ projectId, jobId }` as `POST /projects` (so the wizard polls the scaffold job
 * exactly like the use-existing-empty path). Reuses the task-18 create 409s
 * (`github_not_connected` / `git_ops_in_flight` / `project_exists`); a failure of the
 * GitHub user-token dance itself is a distinct `502 repo_creation_failed`.
 */
export function registerRepoProvisioningRoutes(
  app: FastifyInstance,
  deps: RepoProvisioningRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------- the user-authorization URL
  r.get(
    "/projects/repo-authorize-url",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: RepoAuthorizeUrlQuerySchema,
        response: {
          200: RepoAuthorizeUrlResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const url = service.authorizeUrl({
        redirectUri: req.query.redirectUri,
        state: req.query.state,
      });
      return { url };
    },
  );

  // ------------------------------ exchange code → create repo → create project
  r.post(
    "/projects/create-repo",
    {
      preHandler: app.requireAuth,
      schema: {
        body: CreateRepoRequestSchema,
        response: {
          201: CreateProjectResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await service.createRepoAndProject(
          req.authUser!.id,
          req.body,
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof GithubNotConnectedError) {
          return reply
            .code(409)
            .send({ error: "github_not_connected", message: err.message });
        }
        if (err instanceof GitOpsInFlightError) {
          return reply
            .code(409)
            .send({ error: "git_ops_in_flight", message: err.message });
        }
        if (err instanceof ProjectAlreadyExistsError) {
          return reply
            .code(409)
            .send({ error: "project_exists", message: err.message });
        }
        if (err instanceof RepoCreationError) {
          return reply
            .code(502)
            .send({ error: "repo_creation_failed", message: err.message });
        }
        throw err;
      }
    },
  );
}
