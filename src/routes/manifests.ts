import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ManifestRefQuerySchema,
  ManifestResponseSchema,
  ProjectIdParamSchema,
} from "@supagloo/database-lib";
import { withPostgresSafeStrings } from "../postgres-text";
import type { ManifestService } from "../manifests/manifest-service";
import {
  ManifestInvalidError,
  ManifestNotFoundError,
} from "../manifests/errors";
import { GithubNotConnectedError } from "../connections/errors";
import {
  GITHUB_UPSTREAM_ERROR_SLUG,
  GITHUB_UPSTREAM_STATUS,
  isUpstreamGithubError,
} from "../connections/github-app-client";
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
 * file/branch absent → 404; corrupt manifest (bad JSON or schema mismatch) → 422; GitHub
 * itself failing (the token exchange or the Contents GET) → **502**, never GitHub's own
 * status (see `isUpstreamGithubError`).
 */
export function registerManifestRoutes(
  app: FastifyInstance,
  deps: ManifestRoutesDeps,
): void {

  // ---------------------------------------------- the path-parameter text gate (N2, widened)
  //
  // db-lib's `:id` param schemas are bare `z.string().min(1)`, and db-lib is not editable from
  // this repo, so each is REFINED here with the shared "safe to bind as Postgres text" rule
  // (`../postgres-text`). Without it a NUL in the path reached Prisma and answered a 500 to a
  // caller holding a valid session — MEASURED on every route below before this change.
  //
  // Refining is deliberate rather than re-declaring: `withPostgresSafeStrings` returns a NEW
  // schema (proven — the db-lib object is not mutated, so other consumers are unaffected) that
  // keeps db-lib's own rules and adds one check. And it WALKS the parsed value instead of naming
  // fields, so a route that grows a second path parameter is covered with no change here.
  //
  // A 400, not a 404: "not a well-formed id" is a different fact from "no such thing", and
  // uniform denial is untouched — an ordinary unknown id is still an indistinguishable 404,
  // because the rule is about what Postgres can CARRY and not about what an id looks like.
  // `src/routes/path-params-gate.test.ts` holds this for EVERY parameterised route in the app,
  // including ones not yet written.
  const ProjectIdParam = withPostgresSafeStrings(ProjectIdParamSchema);
  const { service } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/projects/:id/manifest",
    {
      preHandler: app.requireAuth,
      schema: {
        params: ProjectIdParam,
        querystring: ManifestRefQuerySchema,
        response: {
          200: ManifestResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
          502: errorResponseSchema,
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
        // GitHub failed on the way to the file — db-lib's `mintInstallationToken`
        // (which runs first, inside `getRepositoryFileContents`) or the Contents GET
        // itself. Distinctly NOT this route's 404: "GitHub is broken" and "the manifest
        // is absent at that ref" are different answers, and an upstream 401 replied as
        // OUR 401 reads to the web client as an expired session. See
        // `isUpstreamGithubError`.
        if (isUpstreamGithubError(err)) {
          return reply
            .code(GITHUB_UPSTREAM_STATUS)
            .send({ error: GITHUB_UPSTREAM_ERROR_SLUG, message: err.message });
        }
        throw err;
      }
    },
  );
}
