import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  TestSeedRequestSchema,
  TestSeedResponseSchema,
} from "@supagloo/database-lib";
import type { AuthService } from "../auth/auth-service";
import { toAuthUser } from "../auth/dto";

export interface TestSeedDeps {
  authService: Pick<AuthService, "seed">;
  env: {
    NODE_ENV: "development" | "test" | "production";
    SUPAGLOO_ENABLE_TEST_SEED?: string;
  };
}

/**
 * Flag-gated deterministic seed endpoint (design-delta §9-Q9). It must behave as
 * if it does not exist unless BOTH `NODE_ENV !== 'production'` AND
 * `SUPAGLOO_ENABLE_TEST_SEED === '1'`. We enforce the hard-404 by simply NOT
 * registering the route when the gate fails — Fastify's own not-found handler
 * then answers exactly as for any unknown path (never a 401/403 that would leak
 * the route's existence). Never enabled in a production image.
 */
export function registerTestSeedRoute(
  app: FastifyInstance,
  deps: TestSeedDeps,
): void {
  const enabled =
    deps.env.NODE_ENV !== "production" &&
    deps.env.SUPAGLOO_ENABLE_TEST_SEED === "1";
  if (!enabled) return;

  app.withTypeProvider<ZodTypeProvider>().post(
    "/test/seed",
    {
      schema: {
        body: TestSeedRequestSchema,
        response: { 200: TestSeedResponseSchema },
      },
    },
    async (req) => {
      const result = await deps.authService.seed(req.body);
      return {
        users: result.users.map((u) => ({
          user: toAuthUser(u.user),
          token: u.token,
        })),
      };
    },
  );
}
