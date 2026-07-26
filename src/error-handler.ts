import type { FastifyInstance } from "fastify";

/**
 * The application-wide error handler — DEFENCE IN DEPTH, not the primary error contract.
 *
 * WHY IT EXISTS. Until 2026-07-26 this app registered no `setErrorHandler` at all, so
 * anything escaping a route handler was answered by Fastify's default handler, which puts the
 * thrown error's own `message` and `code` on the wire. An adversarial audit of the gallery
 * surface drove four distinct UNAUTHENTICATED 500s out of `GET /v1/gallery` and every one of
 * them replied with the Prisma error code, the Postgres SQLSTATE and the offending literal —
 * e.g. `{"code":"P2010", … "Raw query failed. Code: `22007`. Message: `ERROR: invalid input
 * syntax for type timestamp with time zone: \"2026\"`"}` to a caller with no session. The four
 * inputs are now rejected at the codec boundary (`gallery-query.ts`), which is the real fix;
 * this handler is the layer that makes the CLASS of leak impossible rather than the five
 * instances of it.
 *
 * WHAT IT MUST NOT DO is invent a second error contract. Every intentional reply on this
 * surface is produced by a route handler calling `reply.code(...).send(...)` explicitly, so it
 * never reaches here at all; what does reach here is Fastify's own client errors and genuine
 * accidents. The rule:
 *
 *   - `err.validation` (a Zod/JSON-schema failure) → DELEGATE. `reply.send(err)` inside an
 *     error handler hands off to Fastify's default handler, which reproduces the existing body
 *     byte-for-byte, including the `querystring/sort …` message that route tests assert.
 *   - an explicit `statusCode` in 400…599 EXCEPT 500 → DELEGATE. That number is always
 *     deliberate: Fastify sets it on its own errors (`FST_ERR_CTP_INVALID_JSON_BODY`, 415, …)
 *     and this codebase's typed domain errors declare it (`readonly statusCode = 409`), as
 *     does `GithubAppRequestError`'s `502`. Prisma, AWS-SDK and Node errors carry no
 *     `statusCode`, so nothing accidental lands in this branch.
 *   - EVERYTHING ELSE → a generic 500. That includes `statusCode === 500` itself (500 means
 *     "unclassified", so its message cannot be a contract — `FST_ERR_RESPONSE_SERIALIZATION`
 *     is exactly this case) and anything carrying a status under some OTHER field name.
 *
 * THAT LAST POINT IS A DELIBERATE BEHAVIOUR CHANGE, and a good one. Fastify's default handler
 * prefers `error.status` over `error.statusCode`, which is the trap documented at length in
 * `connections/github-app-client.ts`: db-lib's `GithubAppError` named its upstream status
 * `status`, so a GitHub 401 on a token exchange became OUR 401 — telling a caller with a
 * perfectly good session to sign in again. The routes now catch by CLASS and choose 502
 * themselves, and this handler removes the fallback that made the trap reachable at all: an
 * uncaught provider error can no longer dictate any status.
 *
 * The full error is LOGGED (with the route and the request id) before it is generified, so
 * nothing is lost — it moves from the caller's screen to the operator's log, which is where it
 * belonged.
 */

/** The one generic body. `internal_error` matches the `{ error, message }` shape every other
 *  error on this surface uses, so a client needs no second parser. */
export const INTERNAL_ERROR_BODY = {
  error: "internal_error",
  message: "an unexpected error occurred",
} as const;

/**
 * Is this error's status an intentional part of some route's contract?
 *
 * DUCK-TYPED on purpose. Fastify 5 types the error handler's first argument as `unknown`, and
 * that is the truth of it — a `throw` can produce anything, and a real Prisma error is not
 * `instanceof` anything importable from here. The two fields read below are exactly the two
 * Fastify itself reads.
 */
export function carriesIntentionalStatus(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { validation?: unknown; statusCode?: unknown };
  if (e.validation) return true;
  const status = e.statusCode;
  return typeof status === "number" && status >= 400 && status < 600 && status !== 500;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (carriesIntentionalStatus(err)) {
      // Delegate to Fastify's default handler: identical status, identical body.
      return reply.send(err);
    }
    req.log.error(
      { err, method: req.method, url: req.url, reqId: req.id },
      "unhandled error — replying with a generic 500",
    );
    return reply.code(500).send(INTERNAL_ERROR_BODY);
  });
}
