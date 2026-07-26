import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { mintInstallationToken } from "@supagloo/database-lib";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerGithubConnectionRoutes, registerGithubRepoRoutes } from "./github";
import { GithubAppRequestError } from "../connections/github-app-client";
import {
  InstallationVerificationError,
  GithubNotConnectedError,
} from "../connections/errors";

// Thin-handler wiring for the GitHub routes (design-delta §8). Isolated from the
// DB/network with a FAKE service + FAKE auth service, driven via app.inject. All
// four routes require the bearer session; typed service errors map to statuses.

const CONNECTION = {
  userId: "u1",
  githubLogin: "acme",
  installationId: "42",
  repositorySelection: "selected",
  status: "connected",
  connectedAt: new Date("2026-07-18T00:00:00.000Z"),
};
const REPOS = [
  { id: 1, name: "empty-one", fullName: "acme/empty-one", owner: "acme", private: true, defaultBranch: "main", empty: true },
  { id: 3, name: "psalms-video", fullName: "acme/psalms-video", owner: "acme", private: false, defaultBranch: "main", empty: false },
];

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

function makeFakeService(overrides: Record<string, any> = {}) {
  return {
    installUrl: () => "https://github.com/apps/supagloo-app/installations/new",
    connectFromCallback: async () => CONNECTION,
    disconnect: async () => {},
    listRepos: async () => REPOS,
    ...overrides,
  } as any;
}

async function buildApp(service: any): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(bearerAuthPlugin, { authService: fakeAuthService as any });
  registerGithubConnectionRoutes(app, { service });
  registerGithubRepoRoutes(app, { service });
  await app.ready();
  return app;
}

const BEARER = { authorization: "Bearer valid" };

describe("GitHub routes — auth guard", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  // A valid payload for the callback so this case isolates the AUTH guard —
  // Fastify validates the body before the preHandler, so a missing body would
  // 400 first (standard ordering, same as the auth routes).
  for (const [method, url, payload] of [
    ["GET", "/connections/github/install-url", undefined],
    ["POST", "/connections/github/callback", { installationId: "42" }],
    ["DELETE", "/connections/github", undefined],
    ["GET", "/github/repos", undefined],
  ] as const) {
    it(`${method} ${url} 401s without a bearer token`, async () => {
      app = await buildApp(makeFakeService());
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(401);
    });
  }
});

describe("GitHub routes — happy paths", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("GET install-url returns { url }", async () => {
    app = await buildApp(makeFakeService());
    const res = await app.inject({
      method: "GET",
      url: "/connections/github/install-url",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain("/apps/supagloo-app/installations/new");
  });

  it("POST callback returns the stored connection (ISO connectedAt)", async () => {
    app = await buildApp(makeFakeService());
    const res = await app.inject({
      method: "POST",
      url: "/connections/github/callback",
      headers: BEARER,
      payload: { installationId: "42" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connection.installationId).toBe("42");
    expect(body.connection.githubLogin).toBe("acme");
    expect(body.connection.connectedAt).toBe("2026-07-18T00:00:00.000Z");
  });

  it("DELETE disconnect returns { ok: true }", async () => {
    app = await buildApp(makeFakeService());
    const res = await app.inject({
      method: "DELETE",
      url: "/connections/github",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET repos returns { repositories } and passes filter/q to the service", async () => {
    let seen: any;
    app = await buildApp(
      makeFakeService({
        listRepos: async (_userId: string, opts: any) => {
          seen = opts;
          return REPOS;
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/github/repos?filter=empty&q=one",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repositories).toHaveLength(2);
    expect(seen).toEqual({ filter: "empty", q: "one" });
  });

  it("GET repos defaults filter to 'all' when omitted", async () => {
    let seen: any;
    app = await buildApp(
      makeFakeService({
        listRepos: async (_u: string, opts: any) => {
          seen = opts;
          return REPOS;
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/github/repos",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(seen.filter).toBe("all");
  });
});

describe("GitHub routes — error mapping", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("callback maps InstallationVerificationError to 400", async () => {
    app = await buildApp(
      makeFakeService({
        connectFromCallback: async () => {
          throw new InstallationVerificationError("nope");
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/connections/github/callback",
      headers: BEARER,
      payload: { installationId: "999" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("repos maps GithubNotConnectedError to 409", async () => {
    app = await buildApp(
      makeFakeService({
        listRepos: async () => {
          throw new GithubNotConnectedError();
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/github/repos?filter=all",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(409);
  });

  it("repos rejects an out-of-enum filter with 400", async () => {
    app = await buildApp(makeFakeService());
    const res = await app.inject({
      method: "GET",
      url: "/github/repos?filter=mine",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ───────────────────── upstream GitHub failures never become OUR status ──────
//
// Fastify's default error handler derives the reply status from the thrown error:
// `error.status` first, then `error.statusCode`
// (`fastify/lib/error-handler.js` `setErrorHeaders`). This app registers NO
// `setErrorHandler`, so any error escaping a handler dictates the wire status by
// whatever fields it happens to carry.
//
// `GET /v1/github/repos` reaches GitHub twice — `mintInstallationToken` (db-lib) and
// the listing walk (`GithubAppRequestError`) — and NEITHER `GithubConnectionService`
// nor this route catches either class. A GitHub **401** on the token exchange (a wrong
// App credential, a revoked install) was therefore replied to the browser as OUR 401 —
// telling the caller to re-authenticate, indistinguishable from a real session expiry,
// when the caller's session was fine and OUR credential was the broken one. A 404
// became a spurious "not found".
//
// The rule this suite pins: an upstream provider failure is **502**, always, and no
// provider error class can dictate our status whatever its fields are named.

/** A real RSA key so db-lib's App-JWT signing is genuinely exercised. */
const { privateKey: PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/**
 * A GENUINE db-lib `GithubAppError` — the exact object production throws — obtained by
 * running `mintInstallationToken` against a hostile fake fetch. Deliberately NOT a
 * hand-rolled stand-in: a stand-in would carry whichever fields this test chose, and the
 * whole question here is which fields the REAL error carries onto the wire.
 */
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

describe("GitHub routes — an upstream status never becomes the reply status", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  for (const upstream of [401, 404, 500]) {
    it(`repos replies 502 when db-lib's GithubAppError carries an upstream ${upstream}`, async () => {
      const err = await realTokenExchangeError(upstream);
      app = await buildApp(
        makeFakeService({
          listRepos: async () => {
            throw err;
          },
        }),
      );
      const res = await app.inject({
        method: "GET",
        url: "/github/repos",
        headers: BEARER,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("github_upstream_failed");
    });
  }

  it("repos replies 502 when the client's own GithubAppRequestError escapes", async () => {
    app = await buildApp(
      makeFakeService({
        listRepos: async () => {
          throw new GithubAppRequestError("listing walk failed: 401", {
            upstreamStatus: 401,
          });
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/github/repos",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("github_upstream_failed");
  });

  it("repos replies 502 even if a future db-lib re-adds a literal `status` field", async () => {
    // Defence in depth, and the reason the route catches by CLASS rather than trusting
    // the error's own `statusCode`. If the rename this row made is ever reverted
    // upstream — a one-word change in another repo, invisible from here — the route
    // must still refuse to leak GitHub's status.
    const err = (await realTokenExchangeError(401)) as Record<string, unknown>;
    Object.defineProperty(err, "status", { value: 401, enumerable: false });
    app = await buildApp(
      makeFakeService({
        listRepos: async () => {
          throw err;
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/github/repos",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(502);
  });

  it("callback replies 502 when the installation verify fails upstream", async () => {
    app = await buildApp(
      makeFakeService({
        connectFromCallback: async () => {
          throw new GithubAppRequestError("verify failed: 500", {
            upstreamStatus: 500,
          });
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/connections/github/callback",
      headers: BEARER,
      payload: { installationId: "42" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("github_upstream_failed");
  });
});
