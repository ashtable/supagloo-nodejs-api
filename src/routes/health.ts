import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

/**
 * Liveness response. `/healthz` is public, unauthenticated, and unversioned
 * (NOT under `/v1`) per design-delta §8 — a minimal liveness check with no
 * dependency ping.
 */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export function registerHealthRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/healthz",
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({ status: "ok" as const }),
  );
}
