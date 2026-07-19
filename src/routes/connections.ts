import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ConnectionsResponseSchema,
  GlooConnectRequestSchema,
  GlooConnectionResponseSchema,
  GlooDisconnectResponseSchema,
  OpenRouterConnectRequestSchema,
  OpenRouterConnectionResponseSchema,
  OpenRouterCreditsResponseSchema,
  OpenRouterDisconnectResponseSchema,
} from "@supagloo/database-lib";
import type { OpenRouterConnectionService } from "../connections/openrouter-connection-service";
import type { GlooConnectionService } from "../connections/gloo-connection-service";
import type { ConnectionsService } from "../connections/connections-service";
import {
  GlooVerificationError,
  OpenRouterNotConnectedError,
} from "../connections/errors";
import {
  toGithubConnectionDto,
  toGlooConnectionDto,
  toOpenRouterConnectionDto,
} from "../connections/dto";
import { errorResponseSchema } from "./auth";

export interface ConnectionRoutesDeps {
  openrouter: OpenRouterConnectionService;
  gloo: GlooConnectionService;
  /** Merged reader for `GET /connections` (reads all three connection tables). */
  reader: ConnectionsService;
}

/**
 * OpenRouter + Gloo + merged connection routes (design-delta §2.5/§8), on the
 * `/v1`-scoped instance. All require a bearer session (`app.requireAuth`) — per-user
 * routes. OpenRouter is created with POST (browser did PKCE — no verify); Gloo with
 * PUT (verify-then-store — a client-credentials mint must succeed first). Secrets
 * are encrypted at rest and NEVER cross the wire.
 */
export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: ConnectionRoutesDeps,
): void {
  const { openrouter, gloo, reader } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ------------------------------------------------------------ merged status
  r.get(
    "/connections",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: ConnectionsResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const all = await reader.readAll(req.authUser!.id);
      return {
        github: all.github ? toGithubConnectionDto(all.github) : null,
        openrouter: all.openrouter
          ? toOpenRouterConnectionDto(all.openrouter)
          : null,
        gloo: all.gloo ? toGlooConnectionDto(all.gloo) : null,
      };
    },
  );

  // -------------------------------------------------------------- OpenRouter
  r.post(
    "/connections/openrouter",
    {
      preHandler: app.requireAuth,
      schema: {
        body: OpenRouterConnectRequestSchema,
        response: {
          200: OpenRouterConnectionResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const connection = await openrouter.connect(
        req.authUser!.id,
        req.body.key,
      );
      return { connection: toOpenRouterConnectionDto(connection) };
    },
  );

  r.get(
    "/connections/openrouter/credits",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: OpenRouterCreditsResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        return await openrouter.getCredits(req.authUser!.id);
      } catch (err) {
        if (err instanceof OpenRouterNotConnectedError) {
          return reply
            .code(409)
            .send({ error: "openrouter_not_connected", message: err.message });
        }
        throw err;
      }
    },
  );

  r.delete(
    "/connections/openrouter",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: OpenRouterDisconnectResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      await openrouter.disconnect(req.authUser!.id);
      return { ok: true as const };
    },
  );

  // -------------------------------------------------------------------- Gloo
  r.put(
    "/connections/gloo",
    {
      preHandler: app.requireAuth,
      schema: {
        body: GlooConnectRequestSchema,
        response: {
          200: GlooConnectionResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const connection = await gloo.connect(req.authUser!.id, {
          clientId: req.body.clientId,
          clientSecret: req.body.clientSecret,
        });
        return { connection: toGlooConnectionDto(connection) };
      } catch (err) {
        if (err instanceof GlooVerificationError) {
          return reply
            .code(400)
            .send({ error: "invalid_gloo_credentials", message: err.message });
        }
        throw err;
      }
    },
  );

  r.delete(
    "/connections/gloo",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: GlooDisconnectResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      await gloo.disconnect(req.authUser!.id);
      return { ok: true as const };
    },
  );
}
