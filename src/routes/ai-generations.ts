import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AiGenerationIdParamSchema,
  AiGenerationListResponseSchema,
  AiGenerationResponseSchema,
  CreateAiGenerationRequestSchema,
  CreateAiGenerationResponseSchema,
  ProjectIdParamSchema,
} from "@supagloo/database-lib";
import type { AiGenerationsService } from "../ai/ai-generations-service";
import {
  AiGenerationNotFoundError,
  GenerationNotCancelableError,
  KindProviderIncompatibleError,
  UnsupportedGenerationKindError,
} from "../ai/errors";
import { ProjectNotFoundError } from "../projects/errors";
import { toAiGenerationDto } from "../ai/dto";
import { errorResponseSchema } from "./auth";

export interface AiGenerationRoutesDeps {
  service: AiGenerationsService;
}

/**
 * AI-generation routes (design-delta §2.8/§7/§8), on the `/v1`-scoped instance. All
 * require a bearer session (`app.requireAuth`) and are owner-scoped by the service.
 *
 * - `POST /ai/generations` — kind-specific Zod input validation (400), then the service's
 *   two pre-row gates: matrix incompatibility → 422, matrix-valid-but-unwired kind → 501;
 *   on success create the row + enqueue and return `{ generationId }` (201).
 * - `GET /ai/generations/:id` — the poll shape, scoped directly on the caller.
 * - `GET /projects/:id/generations` — the project's generations (project owner-scoped).
 * - `POST /ai/generations/:id/cancel` — cancel a queued/running generation (409 if
 *   terminal), returning the updated generation.
 *
 * A foreign/unknown generation or project surfaces as a uniform 404 (never leaks existence).
 */
export function registerAiGenerationRoutes(
  app: FastifyInstance,
  deps: AiGenerationRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  const notFound = (reply: FastifyReply, message: string) =>
    reply.code(404).send({ error: "not_found", message });

  // -------------------------------------------------- create + enqueue
  r.post(
    "/ai/generations",
    {
      preHandler: app.requireAuth,
      schema: {
        body: CreateAiGenerationRequestSchema,
        response: {
          201: CreateAiGenerationResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
          501: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await service.createGeneration(req.authUser!.id, req.body);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return notFound(reply, err.message);
        }
        if (err instanceof KindProviderIncompatibleError) {
          return reply
            .code(422)
            .send({ error: "kind_provider_incompatible", message: err.message });
        }
        if (err instanceof UnsupportedGenerationKindError) {
          return reply
            .code(501)
            .send({ error: "generation_kind_unsupported", message: err.message });
        }
        throw err;
      }
    },
  );

  // ----------------------------------------------------- get by id
  r.get(
    "/ai/generations/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: AiGenerationIdParamSchema,
        response: {
          200: AiGenerationResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const generation = await service.getGeneration(
          req.authUser!.id,
          req.params.id,
        );
        return { generation: toAiGenerationDto(generation) };
      } catch (err) {
        if (err instanceof AiGenerationNotFoundError) {
          return notFound(reply, err.message);
        }
        throw err;
      }
    },
  );

  // --------------------------------------------- project-scoped list
  r.get(
    "/projects/:id/generations",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectIdParamSchema,
        response: {
          200: AiGenerationListResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const generations = await service.listProjectGenerations(
          req.authUser!.id,
          req.params.id,
        );
        return { generations: generations.map(toAiGenerationDto) };
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return notFound(reply, err.message);
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------- cancel
  r.post(
    "/ai/generations/:id/cancel",
    {
      preHandler: app.requireAuth,
      schema: {
        params: AiGenerationIdParamSchema,
        response: {
          200: AiGenerationResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const generation = await service.cancelGeneration(
          req.authUser!.id,
          req.params.id,
        );
        return { generation: toAiGenerationDto(generation) };
      } catch (err) {
        if (err instanceof AiGenerationNotFoundError) {
          return notFound(reply, err.message);
        }
        if (err instanceof GenerationNotCancelableError) {
          return reply
            .code(409)
            .send({ error: "generation_not_cancelable", message: err.message });
        }
        throw err;
      }
    },
  );
}
