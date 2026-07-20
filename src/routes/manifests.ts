import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ManifestRefQuerySchema,
  ManifestResponseSchema,
  ProjectIdParamSchema,
} from "@supagloo/database-lib";
import type { ManifestService } from "../manifests/manifest-service";
import {
  ManifestInvalidError,
  ManifestNotFoundError,
} from "../manifests/errors";
import { GithubNotConnectedError } from "../connections/errors";
import { ProjectNotFoundError } from "../projects/errors";
import { errorResponseSchema } from "./auth";

export interface ManifestRoutesDeps {
  service: ManifestService;
}

/**
 * Manifest read route (design-delta §5.3/§8), on the `/v1`-scoped instance. One route:
 * `GET /projects/:id/manifest?ref=`, bearer-authed (`app.requireAuth`). Owner-scoped by
 * the service; reads `supagloo.project.json` from the repo via the GitHub Contents API
 * and returns the Zod-parsed manifest. Error mapping (explicit `instanceof`, house
 * style): project missing/foreign/deleted → 404; no GitHub connection → 409; manifest
 * file/branch absent → 404; corrupt manifest (bad JSON or schema mismatch) → 422.
 */
export function registerManifestRoutes(
  app: FastifyInstance,
  deps: ManifestRoutesDeps,
): void {
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/projects/:id/manifest",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectIdParamSchema,
        querystring: ManifestRefQuerySchema,
        response: {
          200: ManifestResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const manifest = await service.readManifest(
          req.authUser!.id,
          req.params.id,
          req.query.ref,
        );
        return { manifest };
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: err.message });
        }
        if (err instanceof ManifestNotFoundError) {
          return reply
            .code(404)
            .send({ error: "manifest_not_found", message: err.message });
        }
        if (err instanceof GithubNotConnectedError) {
          return reply
            .code(409)
            .send({ error: "github_not_connected", message: err.message });
        }
        if (err instanceof ManifestInvalidError) {
          return reply
            .code(422)
            .send({ error: "manifest_invalid", message: err.message });
        }
        throw err;
      }
    },
  );
}
