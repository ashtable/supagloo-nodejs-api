import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { mintInstallationToken } from "@supagloo/database-lib";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerManifestRoutes } from "./manifests";
import { GithubAppRequestError } from "../connections/github-app-client";
import { GithubNotConnectedError } from "../connections/errors";
import { ManifestInvalidError, ManifestNotFoundError } from "../manifests/errors";
import { ProjectNotFoundError } from "../projects/errors";

// Thin-handler wiring for `GET /v1/projects/:id/manifest` (design-delta §5.3/§8),
// isolated from the DB and the network with a FAKE ManifestService + FAKE auth
// service and driven through `app.inject` — so every assertion here is about what
// the WIRE sees, which is the only thing the web client can react to.

const MANIFEST = {
  manifestVersion: 1 as const,
  composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
  scenes: [],
  narratorVoice: { description: "Calm, measured narrator" },
};

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

function makeFakeService(overrides: Record<string, any> = {}) {
  return {
    readManifest: async () => MANIFEST,
    ...overrides,
  } as any;
}

async function buildApp(service: any): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(bearerAuthPlugin, { authService: fakeAuthService as any });
  registerManifestRoutes(app, { service });
  await app.ready();
  return app;
}

const BEARER = { authorization: "Bearer valid" };
const URL_ = "/projects/p1/manifest";

describe("Manifest route — auth + typed error mapping", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("401s without a bearer token", async () => {
    app = await buildApp(makeFakeService());
    const res = await app.inject({ method: "GET", url: URL_ });
    expect(res.statusCode).toBe(401);
  });

  it("returns { manifest } and passes the ref through to the service", async () => {
    let seen: unknown[] = [];
    app = await buildApp(
      makeFakeService({
        readManifest: async (...args: unknown[]) => {
          seen = args;
          return MANIFEST;
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `${URL_}?ref=feature%2Fx`,
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().manifest).toEqual(MANIFEST);
    expect(seen).toEqual(["u1", "p1", "feature/x"]);
  });

  for (const [Err, status] of [
    [ProjectNotFoundError, 404],
    [ManifestNotFoundError, 404],
    [GithubNotConnectedError, 409],
    [ManifestInvalidError, 422],
  ] as const) {
    it(`maps ${Err.name} to ${status}`, async () => {
      app = await buildApp(
        makeFakeService({
          readManifest: async () => {
            throw new (Err as any)();
          },
        }),
      );
      const res = await app.inject({ method: "GET", url: URL_, headers: BEARER });
      expect(res.statusCode).toBe(status);
    });
  }
});

// ───────────────────── upstream GitHub failures never become OUR status ──────
//
// The SECOND exposed route (the repo listing is the other — see
// `src/routes/github.test.ts`). `ManifestService.readManifest` reaches GitHub through
// `getRepositoryFileContents`, which mints a fresh installation token first; db-lib's
// `mintInstallationToken` throws `GithubAppError` straight out of it, and neither the
// service nor this route ever caught it. With Fastify preferring `error.status` over
// `error.statusCode`, a GitHub 401 on that exchange was replied as OUR 401 — telling the
// caller to re-authenticate when its session was fine and OUR credential was broken — and a
// GitHub 404 as a spurious "manifest not found", a genuinely misleading answer on a route
// whose 404 has a specific, different meaning.
//
// The app also registers a `setErrorHandler` now (`src/error-handler.ts`, 2026-07-26) which
// would generify such an escape to a 500. This suite deliberately builds a BARE Fastify
// instance without it, because what is under test here is the ROUTE's own catch — the answer
// must be a correct 502 with a named slug, which no global fallback can produce.

const { privateKey: PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** A GENUINE db-lib `GithubAppError` — the exact object production throws — rather than
 *  a hand-rolled stand-in whose fields this test would have chosen itself. */
async function realTokenExchangeError(status: number): Promise<unknown> {
  return mintInstallationToken({
    appId: "123456",
    privateKey: PRIVATE_KEY,
    installationId: "42",
    apiBaseUrl: "https://api.github.com",
    maxAttempts: 1,
    sleepImpl: async () => {},
    fetchImpl: (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status,
      })) as unknown as typeof fetch,
  }).then(
    () => {
      throw new Error(`expected a ${status} token exchange to reject`);
    },
    (err: unknown) => err,
  );
}

describe("Manifest route — an upstream status never becomes the reply status", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  for (const upstream of [401, 404, 500]) {
    it(`replies 502 when db-lib's GithubAppError carries an upstream ${upstream}`, async () => {
      const err = await realTokenExchangeError(upstream);
      app = await buildApp(
        makeFakeService({
          readManifest: async () => {
            throw err;
          },
        }),
      );
      const res = await app.inject({ method: "GET", url: URL_, headers: BEARER });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("github_upstream_failed");
      // Specifically NOT the route's own manifest-absent answer.
      expect(res.json().error).not.toBe("manifest_not_found");
    });
  }

  it("replies 502 when the client's own GithubAppRequestError escapes the contents read", async () => {
    app = await buildApp(
      makeFakeService({
        readManifest: async () => {
          throw new GithubAppRequestError(
            "GitHub contents read failed for acme/widget/supagloo.project.json@main: 403",
            { upstreamStatus: 403 },
          );
        },
      }),
    );
    const res = await app.inject({ method: "GET", url: URL_, headers: BEARER });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("github_upstream_failed");
  });

  it("replies 502 even if a future db-lib re-adds a literal `status` field", async () => {
    const err = (await realTokenExchangeError(404)) as Record<string, unknown>;
    Object.defineProperty(err, "status", { value: 404, enumerable: false });
    app = await buildApp(
      makeFakeService({
        readManifest: async () => {
          throw err;
        },
      }),
    );
    const res = await app.inject({ method: "GET", url: URL_, headers: BEARER });
    expect(res.statusCode).toBe(502);
  });
});
