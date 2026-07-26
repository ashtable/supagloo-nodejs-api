import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  FilePresignDownloadResponseSchema,
  GalleryDeleteResponseSchema,
  GalleryIdParamSchema,
  GalleryItemResponseSchema,
  GalleryListQuerySchema,
  GalleryListResponseSchema,
  PublishGalleryItemRequestSchema,
  RenderIdParamSchema,
} from "@supagloo/database-lib";
import { withPostgresSafeStrings } from "../postgres-text";
import type { GalleryService } from "../gallery/gallery-service";
import {
  GalleryItemAlreadyPublishedError,
  GalleryItemNotFoundError,
  InvalidGalleryCursorError,
  InvalidGallerySearchError,
  RenderNotPublishableError,
  ScriptureBookUnderivableError,
} from "../gallery/errors";
import { errorResponseSchema } from "./auth";

export interface GalleryRoutesDeps {
  service: GalleryService;
}

/**
 * Gallery routes (Tasks #39 + #40, design-delta §2.7/§6c/§8), on the `/v1`-scoped instance.
 *
 * THE UNUSUAL THING ABOUT THIS SURFACE is its auth shape: three routes are reachable with no
 * session at all, which is the one carve-out from bearer auth besides `/healthz`.
 *
 * | route | auth | why |
 * |---|---|---|
 * | `POST /renders/:id/gallery` | `requireAuth` | owner-scoped mutation |
 * | `DELETE /gallery/:id` | `requireAuth` | owner-scoped mutation |
 * | `GET /gallery` | `optionalAuth` | public listing, personalized IF a session is present |
 * | `GET /gallery/:id` | `optionalAuth` | same |
 * | `GET /gallery/:id/stream-url` | NONE | the item is the authorization; nothing is read from the request beyond `:id` |
 * | `POST`/`DELETE /gallery/:id/upvote` | `requireAuth` | a vote belongs to a user |
 *
 * `optionalAuth` is RESOLVE-IF-PRESENT, NEVER 401 (plan D2). A present-but-invalid token
 * degrades to anonymous rather than 401-ing, because the BFF forwards whatever session
 * cookie is present and a user holding a stale one would otherwise get an ERROR PAGE instead
 * of a public gallery. `GET /api/me` is the session-truth endpoint; this is not.
 * Consequently these handlers read `req.authUser?.id ?? null` — never the `!` assertion the
 * authed routes use.
 *
 * `POST /renders/:id/gallery` lives HERE and not in `routes/renders.ts`: it writes a
 * `GalleryItem` and belongs to the gallery module. Noted so it is not read as missing from
 * the render file.
 *
 * `DELETE /gallery/:id` returns `200 { ok: true }` (the `DELETE /v1/projects/:id`
 * precedent), cascades the item's `GalleryUpvote` rows and frees the `renderJobId` unique
 * slot so a render can be re-published. **The S3 objects are NOT deleted** — that is the
 * cleanup workflow's job (current-design §6), so nobody should assume un-publishing reclaims
 * storage.
 *
 * Registration order is static-before-parameterised (`/gallery` → `/gallery/:id/stream-url`
 * → `/gallery/:id/upvote` → `/gallery/:id`), mirroring `routes/renders.ts`. Fastify's radix
 * router prefers static segments anyway; the explicit order keeps it obvious.
 *
 * `GET /gallery` has TWO 400 slugs — `invalid_cursor` and `invalid_query` — because its two
 * client-supplied parameters fail for unrelated reasons and are fixed by unrelated client
 * changes. Both are raised by the service's codec (`gallery-query.ts`) before any SQL exists,
 * which is what keeps a hostile-but-structurally-valid cursor or search term from becoming an
 * unauthenticated 500 inside Postgres. `src/error-handler.ts` is the layer under that.
 */
export function registerGalleryRoutes(
  app: FastifyInstance,
  deps: GalleryRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------- the request-string gate (N2)
  //
  // Every schema below is db-lib's, REFINED with the shared "safe to bind as Postgres text"
  // rule (`../postgres-text`) rather than re-declared here. db-lib is not editable from this
  // repo and `GalleryIdParamSchema` is a bare `z.string().min(1)`, so `GET /v1/gallery/%00`
  // and `GET /v1/gallery/%00/stream-url` were UNAUTHENTICATED 500s inside Prisma, and a NUL
  // in `title`, `description` or `translation` was an authenticated one inside the INSERT.
  //
  // `withPostgresSafeStrings` WALKS the parsed value instead of naming fields, which is the
  // point: when db-lib adds a string to the publish body, it is gated with no change here.
  // The previous pass's per-field checks are exactly what let a fourth field slip through.
  //
  // A 400 (not a 404): the caller sent something that is not a well-formed id at all, which
  // is a different fact from "no such item" and is fixed by a different client change. Uniform
  // denial is untouched — an ordinary unknown id is still an indistinguishable 404, because
  // this gate is about what Postgres can CARRY and deliberately not about what an id LOOKS
  // like. A cuid-shaped regex was considered and rejected: it would couple every route to the
  // id GENERATOR (`@default(cuid())` today) and turn every unknown id into a 400.
  const IdParam = withPostgresSafeStrings(GalleryIdParamSchema);
  const RenderIdParam = withPostgresSafeStrings(RenderIdParamSchema);
  const PublishBody = withPostgresSafeStrings(PublishGalleryItemRequestSchema);

  const notFound = (reply: FastifyReply, message: string) =>
    reply.code(404).send({ error: "not_found", message });

  /** The publish/vote/read error map. Every code is justified in `gallery/errors.ts`. */
  const mapError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof GalleryItemNotFoundError) {
      return notFound(reply, err.message);
    }
    if (err instanceof InvalidGalleryCursorError) {
      return reply
        .code(400)
        .send({ error: "invalid_cursor", message: err.message });
    }
    // A SEPARATE 400 slug from `invalid_cursor`: the two are fixed by different client
    // changes, and pointing a caller who sent no cursor at its cursor wastes their time.
    if (err instanceof InvalidGallerySearchError) {
      return reply
        .code(400)
        .send({ error: "invalid_query", message: err.message });
    }
    if (err instanceof RenderNotPublishableError) {
      return reply
        .code(409)
        .send({ error: "render_not_publishable", message: err.message });
    }
    if (err instanceof GalleryItemAlreadyPublishedError) {
      return reply
        .code(409)
        .send({ error: "already_published", message: err.message });
    }
    if (err instanceof ScriptureBookUnderivableError) {
      return reply
        .code(422)
        .send({ error: "scripture_book_underivable", message: err.message });
    }
    throw err;
  };

  // ------------------------------------------------------------------------- publish
  r.post(
    "/renders/:id/gallery",
    {
      preHandler: app.requireAuth,
      schema: {
        params: RenderIdParam,
        body: PublishBody,
        response: {
          201: GalleryItemResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const item = await service.publish(
          req.authUser!.id,
          req.params.id,
          req.body,
        );
        return reply.code(201).send({ item });
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  // ------------------------------------------------------- the public listing (D2/D12)
  // No 401 in the response map, deliberately: `optionalAuth` cannot produce one.
  r.get(
    "/gallery",
    {
      preHandler: app.optionalAuth,
      schema: {
        querystring: GalleryListQuerySchema,
        response: {
          200: GalleryListResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        return await service.listGallery(req.authUser?.id ?? null, req.query);
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  // ---------------------------------------------------------------- stream-url (D13)
  // NO auth hook at all: the row is the authorization (both visibilities are served), the
  // caller never supplies a key, and the URL is short-lived because for an unauthenticated
  // caller the URL *is* the credential.
  r.get(
    "/gallery/:id/stream-url",
    {
      schema: {
        params: IdParam,
        response: {
          200: FilePresignDownloadResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { url, expiresAt } = await service.presignGalleryStream(
          req.params.id,
        );
        return { url, expiresAt: expiresAt.toISOString() };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  // ------------------------------------------------------------- upvotes — row 40 (D10)
  // A duplicate vote is 200 with the current item, NOT 409: re-voting is a no-op with no
  // payload to lose, and 409 is reserved for state conflicts. Un-voting something you never
  // voted for is likewise 200.
  r.post(
    "/gallery/:id/upvote",
    {
      preHandler: app.requireAuth,
      schema: {
        params: IdParam,
        response: {
          200: GalleryItemResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const item = await service.upvote(req.authUser!.id, req.params.id);
        return { item };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  r.delete(
    "/gallery/:id/upvote",
    {
      preHandler: app.requireAuth,
      schema: {
        params: IdParam,
        response: {
          200: GalleryItemResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const item = await service.removeUpvote(req.authUser!.id, req.params.id);
        return { item };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  // ------------------------------------------------------------------- one item (D12)
  r.get(
    "/gallery/:id",
    {
      preHandler: app.optionalAuth,
      schema: {
        params: IdParam,
        response: {
          200: GalleryItemResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const item = await service.getItem(
          req.authUser?.id ?? null,
          req.params.id,
        );
        return { item };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  // -------------------------------------------------------------------- un-publish
  r.delete(
    "/gallery/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: IdParam,
        response: {
          200: GalleryDeleteResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        await service.deleteItem(req.authUser!.id, req.params.id);
        return { ok: true as const };
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );
}
