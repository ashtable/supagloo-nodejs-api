import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { ModelCatalogueService } from "../ai/model-catalogue-service";
import { AiModelCatalogueResponseSchema } from "../ai/model-catalogue-dto";
import { errorResponseSchema } from "./auth";

export interface AiModelRoutesDeps {
  service: ModelCatalogueService;
}

/**
 * `GET /v1/ai/models` — the live AI model catalogue (genesis-1 Inspector, items 1 and 3).
 *
 * This is the "real discovery endpoint" that `supagloo-nextjs/lib/api/ai-config.ts` names
 * in its own header as "the correct long-term fix (tracked as a follow-up)" for its
 * hardcoded default model ids. The Inspector's provider/model selectors and its cost
 * estimate both read from here.
 *
 * **`preHandler: app.requireAuth` is load-bearing.** The `/v1` scope has no global auth
 * hook — `bearerAuthPlugin` only DECORATES the instance — so omitting this line makes the
 * route public rather than merely un-typed. It must not be public: the Gloo half of the
 * catalogue is fetched with a bearer minted from the caller's own stored client
 * credentials.
 *
 * There is no 5xx path by design: the service contains every upstream failure to its own
 * slice and always returns a well-formed (possibly empty) list. A picker that vanishes
 * because a catalogue endpoint had a bad minute is a worse outcome than a short list.
 */
export function registerAiModelRoutes(
  app: FastifyInstance,
  deps: AiModelRoutesDeps,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/ai/models",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: AiModelCatalogueResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req) => deps.service.read(req.authUser!.id),
  );
}
