import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerConnectionRoutes } from "./connections";
import {
  GlooVerificationError,
  OpenRouterNotConnectedError,
} from "../connections/errors";

// Thin-handler wiring for the OpenRouter + Gloo + merged connection routes
// (design-delta §2.5/§8). Isolated from DB/network with FAKE services + FAKE auth,
// driven via app.inject. Every route requires the bearer session; typed service
// errors map to statuses; wire DTOs never carry ciphertext/secret.

const OR_ROW = {
  userId: "u1",
  apiKeyCiphertext: "CIPHERTEXT-OR",
  keyLast4: "wxyz",
  status: "connected",
  connectedAt: new Date("2026-07-18T00:00:00.000Z"),
};
const GLOO_ROW = {
  userId: "u1",
  clientId: "gloo-cid",
  clientSecretCiphertext: "CIPHERTEXT-GLOO",
  status: "connected",
  connectedAt: new Date("2026-07-18T00:00:00.000Z"),
  lastVerifiedAt: new Date("2026-07-18T00:00:00.000Z"),
};

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

function makeDeps(overrides: {
  openrouter?: Record<string, any>;
  gloo?: Record<string, any>;
  reader?: Record<string, any>;
} = {}) {
  return {
    openrouter: {
      connect: async () => OR_ROW,
      getCredits: async () => ({
        totalCredits: 100,
        totalUsage: 12.5,
        remaining: 87.5,
      }),
      disconnect: async () => {},
      ...overrides.openrouter,
    } as any,
    gloo: {
      connect: async () => GLOO_ROW,
      disconnect: async () => {},
      ...overrides.gloo,
    } as any,
    reader: {
      readAll: async () => ({
        github: null,
        openrouter: OR_ROW,
        gloo: GLOO_ROW,
      }),
      ...overrides.reader,
    } as any,
  };
}

async function buildApp(deps: ReturnType<typeof makeDeps>): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(bearerAuthPlugin, { authService: fakeAuthService as any });
  registerConnectionRoutes(app, deps);
  await app.ready();
  return app;
}

const BEARER = { authorization: "Bearer valid" };

describe("Connection routes — auth guard", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  // Valid payloads isolate the AUTH guard (Fastify validates the body first).
  for (const [method, url, payload] of [
    ["GET", "/connections", undefined],
    ["POST", "/connections/openrouter", { key: "sk-or-v1-abc" }],
    ["GET", "/connections/openrouter/credits", undefined],
    ["DELETE", "/connections/openrouter", undefined],
    ["PUT", "/connections/gloo", { clientId: "c", clientSecret: "s" }],
    ["DELETE", "/connections/gloo", undefined],
  ] as const) {
    it(`${method} ${url} 401s without a bearer token`, async () => {
      app = await buildApp(makeDeps());
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(401);
    });
  }
});

describe("Connection routes — OpenRouter", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("POST /connections/openrouter passes the key to connect and returns masked status", async () => {
    let seenKey: string | undefined;
    app = await buildApp(
      makeDeps({
        openrouter: {
          connect: async (_userId: string, key: string) => {
            seenKey = key;
            return OR_ROW;
          },
        },
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/connections/openrouter",
      headers: BEARER,
      payload: { key: "sk-or-v1-secretwxyz" },
    });
    expect(res.statusCode).toBe(200);
    expect(seenKey).toBe("sk-or-v1-secretwxyz");
    const body = res.json();
    expect(body.connection.keyLast4).toBe("wxyz");
    expect(body.connection.connectedAt).toBe("2026-07-18T00:00:00.000Z");
    // No ciphertext ever crosses the wire.
    expect(JSON.stringify(body)).not.toMatch(/ciphertext/i);
  });

  it("POST /connections/openrouter 400s an empty key", async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "POST",
      url: "/connections/openrouter",
      headers: BEARER,
      payload: { key: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /connections/openrouter/credits returns the reshaped balance", async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "GET",
      url: "/connections/openrouter/credits",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      totalCredits: 100,
      totalUsage: 12.5,
      remaining: 87.5,
    });
  });

  it("GET credits maps OpenRouterNotConnectedError to 409", async () => {
    app = await buildApp(
      makeDeps({
        openrouter: {
          getCredits: async () => {
            throw new OpenRouterNotConnectedError();
          },
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/connections/openrouter/credits",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(409);
  });

  it("DELETE /connections/openrouter returns { ok: true }", async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "DELETE",
      url: "/connections/openrouter",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("Connection routes — Gloo", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("PUT /connections/gloo verifies + stores, returning clientId (no secret)", async () => {
    let seen: unknown;
    app = await buildApp(
      makeDeps({
        gloo: {
          connect: async (_userId: string, args: unknown) => {
            seen = args;
            return GLOO_ROW;
          },
        },
      }),
    );
    const res = await app.inject({
      method: "PUT",
      url: "/connections/gloo",
      headers: BEARER,
      payload: { clientId: "gloo-cid", clientSecret: "s3cr3t" },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ clientId: "gloo-cid", clientSecret: "s3cr3t" });
    const body = res.json();
    expect(body.connection.clientId).toBe("gloo-cid");
    expect(body.connection.lastVerifiedAt).toBe("2026-07-18T00:00:00.000Z");
    expect(JSON.stringify(body)).not.toMatch(/secret|ciphertext/i);
  });

  it("PUT /connections/gloo maps GlooVerificationError to 400", async () => {
    app = await buildApp(
      makeDeps({
        gloo: {
          connect: async () => {
            throw new GlooVerificationError("nope");
          },
        },
      }),
    );
    const res = await app.inject({
      method: "PUT",
      url: "/connections/gloo",
      headers: BEARER,
      payload: { clientId: "bad", clientSecret: "bad" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /connections/gloo 400s a missing clientSecret", async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "PUT",
      url: "/connections/gloo",
      headers: BEARER,
      payload: { clientId: "c" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /connections/gloo returns { ok: true }", async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "DELETE",
      url: "/connections/gloo",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("Connection routes — merged GET /connections", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("returns { github, openrouter, gloo } with masked statuses (no secrets)", async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({
      method: "GET",
      url: "/connections",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.github).toBeNull();
    expect(body.openrouter.keyLast4).toBe("wxyz");
    expect(body.openrouter.apiKeyCiphertext).toBeUndefined();
    expect(body.gloo.clientId).toBe("gloo-cid");
    expect(body.gloo.clientSecretCiphertext).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/ciphertext/i);
  });

  it("returns all-null when nothing is connected", async () => {
    app = await buildApp(
      makeDeps({
        reader: {
          readAll: async () => ({ github: null, openrouter: null, gloo: null }),
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/connections",
      headers: BEARER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ github: null, openrouter: null, gloo: null });
  });
});
