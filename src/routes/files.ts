import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  FilePresignDownloadQuerySchema,
  FilePresignDownloadResponseSchema,
} from "@supagloo/database-lib";
import type { FilesService } from "../files/files-service";
import { FileAccessDeniedError } from "../files/errors";
import { errorResponseSchema } from "./auth";

export interface FileRoutesDeps {
  service: FilesService;
}

/** The demo presign's lifetime. Matches the gallery stream's 120 s rather than the authed
 *  300 s default — see the route comment. */
const DEMO_STREAM_TTL_SECONDS = 120;

/**
 * File routes (design-delta §4/§8), on the `/v1`-scoped instance. Two routes, with
 * deliberately opposite auth postures:
 *
 * | route | auth | what authorizes it |
 * |---|---|---|
 * | `GET /files/presign-download?key=` | `app.requireAuth` | the caller owns the key's row |
 * | `GET /demo/stream-url` | NONE | nothing is read from the request at all |
 *
 * The authed one is ownership-scoped by the service; a foreign, unknown, or malformed key
 * surfaces as a uniform 404 (never leaking existence). presign-upload and DELETE are
 * intentionally absent (worker / cleanup-workflow ops).
 *
 * The public one signs a module CONSTANT and takes no parameters — the property that keeps
 * an unauthenticated presigner from becoming a presigning oracle for the whole bucket. It
 * lives here rather than in its own module because it is the same service and the same S3
 * signer; the table above exists so the mixed posture is stated rather than inferred.
 */
export function registerFileRoutes(
  app: FastifyInstance,
  deps: FileRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/files/presign-download",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: FilePresignDownloadQuerySchema,
        response: {
          200: FilePresignDownloadResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { url, expiresAt } = await service.presignDownload(
          req.authUser!.id,
          req.query.key,
        );
        return { url, expiresAt: expiresAt.toISOString() };
      } catch (err) {
        if (err instanceof FileAccessDeniedError) {
          return reply
            .code(404)
            .send({ error: "not_found", message: err.message });
        }
        throw err;
      }
    },
  );

  // ------------------------------------------------------- the landing-page demo (public)
  //
  // NO auth hook — the landing page is served to anonymous visitors, so the demo behind its
  // "▶ Watch the Genesis demo" button has to be too. Same posture as
  // `GET /v1/gallery/:id/stream-url`, and safe for the same reason, arrived at differently:
  // the gallery route lets the caller name a ROW and derives the key from it after checking
  // the row is published; this one lets the caller name NOTHING. The key is a module
  // constant in the service (`DEMO_VIDEO_KEY`) and the method takes no key parameter at all,
  // so there is no request shape that could widen what gets signed.
  //
  // That matters more here than anywhere else in this file: an unauthenticated route that
  // signed a caller-supplied key would presign ANY object in the bucket for ANYONE — every
  // user's renders, scene assets and narration audio — with no credential required.
  //
  // 120 s, matching the gallery stream rather than the 300 s authed default: for an
  // anonymous caller the URL *is* the credential, so it should outlive the click by as
  // little as possible. Long enough for a `<video>` to start and re-request ranges; the
  // player re-fetches on expiry.
  r.get(
    "/demo/stream-url",
    {
      schema: {
        response: { 200: FilePresignDownloadResponseSchema },
      },
    },
    async () => {
      const { url, expiresAt } = await service.presignDemoVideo(
        DEMO_STREAM_TTL_SECONDS,
      );
      return { url, expiresAt: expiresAt.toISOString() };
    },
  );
}
