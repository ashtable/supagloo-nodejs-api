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

/**
 * File routes (design-delta §4/§8), on the `/v1`-scoped instance. Exactly one
 * route: `GET /files/presign-download?key=`, bearer-authed (`app.requireAuth`).
 * The requested key is ownership-scoped to the caller by the service; a foreign,
 * unknown, or malformed key surfaces as a uniform 404 (never leaking existence).
 * presign-upload and DELETE are intentionally absent (worker / cleanup-workflow ops).
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
}
