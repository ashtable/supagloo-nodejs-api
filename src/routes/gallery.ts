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
import type { GalleryService } from "../gallery/gallery-service";
import {
  GalleryItemAlreadyPublishedError,
  GalleryItemNotFoundError,
  InvalidGalleryCursorError,
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
 */
export function registerGalleryRoutes(
  app: FastifyInstance,
  deps: GalleryRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

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
        params: RenderIdParamSchema,
        body: PublishGalleryItemRequestSchema,
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
        params: GalleryIdParamSchema,
        response: {
          200: FilePresignDownloadResponseSchema,
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
        params: GalleryIdParamSchema,
        response: {
          200: GalleryItemResponseSchema,
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
        params: GalleryIdParamSchema,
        response: {
          200: GalleryItemResponseSchema,
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
        params: GalleryIdParamSchema,
        response: {
          200: GalleryItemResponseSchema,
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
        params: GalleryIdParamSchema,
        response: {
          200: GalleryDeleteResponseSchema,
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
