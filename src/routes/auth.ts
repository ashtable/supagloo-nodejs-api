import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  MeResponseSchema,
  OnboardingResponseSchema,
  SignoutResponseSchema,
  YouVersionSignInRequestSchema,
  YouVersionSignInResponseSchema,
} from "@supagloo/database-lib";
import type { AuthService } from "../auth/auth-service";
import { UnauthorizedError } from "../auth/errors";
import { toAuthUser } from "../auth/dto";

/** Shared 401 body shape for the auth routes. */
export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export interface AuthRoutesDeps {
  authService: AuthService;
}

/**
 * Sign-in + session routes (design-delta §6a/§8). Registered on the `/v1`-scoped
 * instance, so paths here are relative (`/auth/youversion` → `/v1/auth/youversion`).
 * `/auth/youversion` is public; `/me`, `/me/onboarding`, `/auth/signout` require
 * a bearer session via `app.requireAuth`.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): void {
  const { authService } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/auth/youversion",
    {
      schema: {
        body: YouVersionSignInRequestSchema,
        response: {
          200: YouVersionSignInResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { token, user, firstSignIn } = await authService.signIn(
          req.body.accessToken,
        );
        return { token, user: toAuthUser(user), firstSignIn };
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return reply
            .code(401)
            .send({ error: "unauthorized", message: err.message });
        }
        throw err;
      }
    },
  );

  r.get(
    "/me",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: MeResponseSchema, 401: errorResponseSchema } },
    },
    async (req) => ({ user: toAuthUser(req.authUser!) }),
  );

  r.patch(
    "/me/onboarding",
    {
      preHandler: app.requireAuth,
      schema: {
        response: { 200: OnboardingResponseSchema, 401: errorResponseSchema },
      },
    },
    async (req) => {
      const user = await authService.completeOnboarding(req.authUser!.id);
      return { user: toAuthUser(user) };
    },
  );

  r.post(
    "/auth/signout",
    {
      preHandler: app.requireAuth,
      schema: {
        response: { 200: SignoutResponseSchema, 401: errorResponseSchema },
      },
    },
    async (req) => {
      await authService.signOut(req.authSession!.id);
      return { ok: true as const };
    },
  );
}
