import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  ProjectJobParamsSchema,
  ProjectJobResponseSchema,
} from "@supagloo/database-lib";
import type { ProjectJobsService } from "../jobs/project-jobs-service";
import {
  GitOpsInFlightError,
  ProjectAlreadyExistsError,
  ProjectJobNotFoundError,
  UnsupportedCreatedFromError,
} from "../jobs/errors";
import { GithubNotConnectedError } from "../connections/errors";
import { ProjectNotFoundError } from "../projects/errors";
import { toProjectJobDto } from "../jobs/dto";
import { errorResponseSchema } from "./auth";

export interface ProjectJobRoutesDeps {
  service: ProjectJobsService;
}

/**
 * Project job-creation + polling routes (design-delta §5.1/§6b/§8), on the
 * `/v1`-scoped instance. Both require a bearer session (`app.requireAuth`) and are
 * owner-scoped by the service.
 *
 * `POST /projects` creates the Project + scaffold ProjectJob and enqueues the
 * scaffoldProject workflow. Its THREE distinct 409s carry distinct `error` codes
 * (`github_not_connected` / `git_ops_in_flight` / `project_exists`) so consumers can
 * tell them apart. `GET /projects/:id/jobs/:jobId` returns the job's status + stage log
 * (a foreign/deleted project or unknown job → a uniform 404).
 *
 * Registered alongside the task-14 read/mutate `projects` routes (different methods /
 * paths, so they coexist under the same `/projects` prefix).
 */
export function registerProjectJobRoutes(
  app: FastifyInstance,
  deps: ProjectJobRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------- create + enqueue scaffold
  r.post(
    "/projects",
    {
      preHandler: app.requireAuth,
      schema: {
        body: CreateProjectRequestSchema,
        response: {
          201: CreateProjectResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await service.createProjectWithScaffold(
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
        if (err instanceof UnsupportedCreatedFromError) {
          return reply
            .code(400)
            .send({ error: "unsupported_created_from", message: err.message });
        }
        throw err;
      }
    },
  );

  // ----------------------------------------------------------- job polling
  r.get(
    "/projects/:id/jobs/:jobId",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectJobParamsSchema,
        response: {
          200: ProjectJobResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const job = await service.getJob(
          req.authUser!.id,
          req.params.id,
          req.params.jobId,
        );
        return { job: toProjectJobDto(job) };
      } catch (err) {
        if (
          err instanceof ProjectNotFoundError ||
          err instanceof ProjectJobNotFoundError
        ) {
          return reply
            .code(404)
            .send({ error: "not_found", message: err.message });
        }
        throw err;
      }
    },
  );
}
