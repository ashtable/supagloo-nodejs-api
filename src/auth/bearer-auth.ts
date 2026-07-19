import fp from "fastify-plugin";
import type {
  FastifyPluginAsync,
  preHandlerHookHandler,
} from "fastify";
import type { Session, User } from "@supagloo/database-lib";

/**
 * Bearer-session auth (design-delta §8). Reads `Authorization: Bearer <token>`,
 * hashes it, resolves it to a live session via the AuthService (which also does
 * the sliding-expiry bump), and exposes the user on the request. Registered with
 * `fastify-plugin` so `requireAuth` is usable by sibling route registrations.
 */
export interface BearerAuthOptions {
  authService: {
    authenticate(
      token: string,
    ): Promise<{ user: User; session: Session } | null>;
  };
}

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler that 401s unless a valid bearer session is presented. */
    requireAuth: preHandlerHookHandler;
  }
  interface FastifyRequest {
    /** Set by {@link FastifyInstance.requireAuth} on a successful auth. */
    authUser: User | null;
    authSession: Session | null;
  }
}

/** Extract the bearer token, or `null` if the header is absent/malformed. */
function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : "";
  return token.length > 0 ? token : null;
}

const plugin: FastifyPluginAsync<BearerAuthOptions> = async (app, opts) => {
  app.decorateRequest("authUser", null);
  app.decorateRequest("authSession", null);

  const requireAuth: preHandlerHookHandler = async (req, reply) => {
    const token = parseBearer(req.headers.authorization);
    if (!token) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "missing bearer token" });
    }
    const result = await opts.authService.authenticate(token);
    if (!result) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "invalid or expired token" });
    }
    req.authUser = result.user;
    req.authSession = result.session;
  };

  app.decorate("requireAuth", requireAuth);
};

export const bearerAuthPlugin = fp(plugin, {
  name: "bearer-auth",
  fastify: "5.x",
});
