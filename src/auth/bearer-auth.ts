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
    /**
     * preHandler that resolves the viewer IF a usable token is present and otherwise
     * continues ANONYMOUSLY. Never 401s. See the `optionalAuth` note in the plugin body.
     */
    optionalAuth: preHandlerHookHandler;
  }
  interface FastifyRequest {
    /** Set by {@link FastifyInstance.requireAuth} or
     *  {@link FastifyInstance.optionalAuth} on a successful auth; `null` otherwise. */
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

  /**
   * OPTIONAL auth, for the public gallery listing (Task #39, plan D2). Semantics —
   * resolve-if-present, NEVER 401:
   *
   * ```
   * no Authorization header      → continue, req.authUser stays null
   * malformed header             → continue, req.authUser stays null (no session lookup)
   * valid token                  → req.authUser/authSession set (sliding expiry bumped)
   * present but invalid/expired  → continue as ANONYMOUS. It does NOT 401.
   * ```
   *
   * WHY DEGRADE ON A BAD TOKEN INSTEAD OF 401-ING: `GET /v1/gallery` is public, and the BFF
   * forwards whatever session cookie is present. A user holding a stale cookie would get an
   * ERROR PAGE instead of a public gallery — breaking browsing for exactly the population
   * most likely to hold one. The client is not told its session is dead by this route, and
   * that is fine: `GET /api/me` is already the session-truth endpoint, and every
   * auth-dependent subtree in the web app is mount-gated on it.
   *
   * WHY IT LIVES IN THIS PLUGIN and not a second one: a second plugin would re-run
   * `decorateRequest("authUser", …)`, which Fastify throws on, and would duplicate
   * `parseBearer`.
   *
   * NOTE, recorded deliberately: `authenticate()` performs the sliding-expiry bump, so a
   * signed-in viewer browsing the gallery extends their session. That is correct (the viewer
   * IS active) and is called out here so it is not later mistaken for a bug.
   *
   * Handlers behind this hook must read `req.authUser?.id ?? null` — never the `!` assertion
   * the `requireAuth` routes use.
   */
  const optionalAuth: preHandlerHookHandler = async (req) => {
    const token = parseBearer(req.headers.authorization);
    // Nothing parseable ⇒ nothing to look up. A malformed header must not cost a session
    // query on every anonymous gallery page view.
    if (!token) return;
    const result = await opts.authService.authenticate(token);
    if (!result) return;
    req.authUser = result.user;
    req.authSession = result.session;
  };

  app.decorate("requireAuth", requireAuth);
  app.decorate("optionalAuth", optionalAuth);
};

export const bearerAuthPlugin = fp(plugin, {
  name: "bearer-auth",
  fastify: "5.x",
});
