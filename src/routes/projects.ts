import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ProjectDeleteResponseSchema,
  ProjectIdParamSchema,
  ProjectListResponseSchema,
  ProjectRenameRequestSchema,
  ProjectResponseSchema,
  ProjectVersionListResponseSchema,
} from "@supagloo/database-lib";
import { withPostgresSafeStrings } from "../postgres-text";
import type { ProjectsService } from "../projects/projects-service";
import { ProjectNotFoundError } from "../projects/errors";
import { toProjectDto, toProjectVersionDto } from "../projects/dto";
import { errorResponseSchema } from "./auth";

export interface ProjectRoutesDeps {
  service: ProjectsService;
}

/**
 * Project + version read/mutate routes (design-delta §2.6/§8), on the `/v1`-scoped
 * instance. All require a bearer session (`app.requireAuth`) and are owner-scoped by
 * the service. A missing / foreign-owner / soft-deleted project surfaces as a uniform
 * 404 (`ProjectNotFoundError`), never leaking existence or distinguishing forbidden
 * from not-found. The create/import/commit/publish endpoints are separate, later,
 * DBOS-backed tasks (#18–22) and are intentionally absent here.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  deps: ProjectRoutesDeps,
): void {

  // ---------------------------------------------- the path-parameter text gate (N2, widened)
  //
  // db-lib's `:id` param schemas are bare `z.string().min(1)`, and db-lib is not editable from
  // this repo, so each is REFINED here with the shared "safe to bind as Postgres text" rule
  // (`../postgres-text`). Without it a NUL in the path reached Prisma and answered a 500 to a
  // caller holding a valid session — MEASURED on every route below before this change.
  //
  // Refining is deliberate rather than re-declaring: `withPostgresSafeStrings` returns a NEW
  // schema (proven — the db-lib object is not mutated, so other consumers are unaffected) that
  // keeps db-lib's own rules and adds one check. And it WALKS the parsed value instead of naming
  // fields, so a route that grows a second path parameter is covered with no change here.
  //
  // A 400, not a 404: "not a well-formed id" is a different fact from "no such thing", and
  // uniform denial is untouched — an ordinary unknown id is still an indistinguishable 404,
  // because the rule is about what Postgres can CARRY and not about what an id looks like.
  // `src/routes/path-params-gate.test.ts` holds this for EVERY parameterised route in the app,
  // including ones not yet written.
  const ProjectIdParam = withPostgresSafeStrings(ProjectIdParamSchema);
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  const notFound = (reply: FastifyReply, err: ProjectNotFoundError) =>
    reply.code(404).send({ error: "not_found", message: err.message });

  // ------------------------------------------------------------ grid listing
  r.get(
    "/projects",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: ProjectListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const projects = await service.listProjects(req.authUser!.id);
      return { projects: projects.map(toProjectDto) };
    },
  );

  // ------------------------------------------------------------- one project
  r.get(
    "/projects/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectIdParam,
        response: {
          200: ProjectResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await service.getProject(req.authUser!.id, req.params.id);
        return { project: toProjectDto(project) };
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return notFound(reply, err);
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------- rename
  r.patch(
    "/projects/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectIdParam,
        body: ProjectRenameRequestSchema,
        response: {
          200: ProjectResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await service.renameProject(
          req.authUser!.id,
          req.params.id,
          req.body.name,
        );
        return { project: toProjectDto(project) };
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return notFound(reply, err);
        throw err;
      }
    },
  );

  // ----------------------------------------------------------- soft delete
  r.delete(
    "/projects/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectIdParam,
        response: {
          200: ProjectDeleteResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        await service.deleteProject(req.authUser!.id, req.params.id);
        return { ok: true as const };
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return notFound(reply, err);
        throw err;
      }
    },
  );

  // -------------------------------------------------------------- versions
  r.get(
    "/projects/:id/versions",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectIdParam,
        response: {
          200: ProjectVersionListResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const versions = await service.listVersions(
          req.authUser!.id,
          req.params.id,
        );
        return { versions: versions.map(toProjectVersionDto) };
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return notFound(reply, err);
        throw err;
      }
    },
  );
}
