import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateRenderRequestSchema,
  CreateRenderResponseSchema,
  FilePresignDownloadResponseSchema,
  ProjectIdParamSchema,
  RenderIdParamSchema,
  RenderJobListResponseSchema,
  RenderJobResponseSchema,
  RenderListQuerySchema,
} from "@supagloo/database-lib";
import { withPostgresSafeStrings } from "../postgres-text";
import type { RendersService } from "../renders/renders-service";
import {
  RenderNotCancelableError,
  RenderNotFoundError,
} from "../renders/errors";
import { ProjectNotFoundError } from "../projects/errors";
import { toRenderJobDto } from "../renders/dto";
import { errorResponseSchema } from "./auth";

export interface RenderRoutesDeps {
  service: RendersService;
}

/**
 * Render routes (Task #37, design-delta §2.7/§6c/§8), on the `/v1`-scoped instance. All
 * require a bearer session (`app.requireAuth`) and are owner-scoped by the service.
 *
 * - `POST /projects/:id/renders` — validate `{versionId, outputSpec, runInBackground}`
 *   at the Zod boundary (400 on a malformed spec), then create the queued `RenderJob`
 *   and enqueue the render workflow; returns `{ renderJobId }` (201).
 * - `GET /renders/:id` — the poll shape driving the 14c overlay.
 * - `POST /renders/:id/cancel` — cancel a non-terminal render (409 if terminal).
 * - `GET /renders?mine=1` — the caller's renders, newest first ("Your videos").
 *   `mine=1` is REQUIRED: there is no cross-user listing, so a bare `GET /renders` is a
 *   400 rather than a URL that reads like "all renders".
 * - `GET /renders/:id/download` — a presigned GET for the completed output, delegated to
 *   the same signer as `GET /v1/files/presign-download`.
 *
 * A foreign/unknown project or render — and a render whose output is not ready — all
 * surface as a uniform 404 (never leaks existence).
 */
export function registerRenderRoutes(
  app: FastifyInstance,
  deps: RenderRoutesDeps,
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
  const RenderIdParam = withPostgresSafeStrings(RenderIdParamSchema);
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  const notFound = (reply: FastifyReply, message: string) =>
    reply.code(404).send({ error: "not_found", message });

  // ------------------------------------------------- create + enqueue a render
  r.post(
    "/projects/:id/renders",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectIdParam,
        body: CreateRenderRequestSchema,
        response: {
          201: CreateRenderResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await service.createRender(
          req.authUser!.id,
          req.params.id,
          req.body,
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return notFound(reply, err.message);
        }
        throw err;
      }
    },
  );

  // ------------------------------------------------------- the caller's renders
  // Registered BEFORE `/renders/:id` so the literal path is matched first (Fastify's
  // radix router prefers static segments, but the explicit order keeps it obvious).
  r.get(
    "/renders",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: RenderListQuerySchema,
        response: {
          200: RenderJobListResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const renders = await service.listMyRenders(req.authUser!.id);
      return { renders: renders.map(toRenderJobDto) };
    },
  );

  // ------------------------------------------------------------------ poll one
  r.get(
    "/renders/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: RenderIdParam,
        response: {
          200: RenderJobResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const render = await service.getRender(req.authUser!.id, req.params.id);
        return { render: toRenderJobDto(render) };
      } catch (err) {
        if (err instanceof RenderNotFoundError) return notFound(reply, err.message);
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------- cancel
  r.post(
    "/renders/:id/cancel",
    {
      preHandler: app.requireAuth,
      schema: {
        params: RenderIdParam,
        response: {
          200: RenderJobResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const render = await service.cancelRender(req.authUser!.id, req.params.id);
        return { render: toRenderJobDto(render) };
      } catch (err) {
        if (err instanceof RenderNotFoundError) return notFound(reply, err.message);
        if (err instanceof RenderNotCancelableError) {
          return reply
            .code(409)
            .send({ error: "render_not_cancelable", message: err.message });
        }
        throw err;
      }
    },
  );

  // ------------------------------------------------------------------ download
  r.get(
    "/renders/:id/download",
    {
      preHandler: app.requireAuth,
      schema: {
        params: RenderIdParam,
        response: {
          200: FilePresignDownloadResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { url, expiresAt } = await service.presignRenderDownload(
          req.authUser!.id,
          req.params.id,
        );
        return { url, expiresAt: expiresAt.toISOString() };
      } catch (err) {
        if (err instanceof RenderNotFoundError) return notFound(reply, err.message);
        throw err;
      }
    },
  );
}
