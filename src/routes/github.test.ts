import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerGithubConnectionRoutes, registerGithubRepoRoutes } from "./github";
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
