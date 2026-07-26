import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { buildApp } from "./app";
import { GalleryService } from "./gallery/gallery-service";
import { registerErrorHandler, INTERNAL_ERROR_BODY } from "./error-handler";
import { errorResponseSchema } from "./routes/auth";

// The application-wide error handler (added 2026-07-26). Two halves:
//
//   1. U-EH1..U-EH5 — the handler in isolation, over probe routes that throw exactly what
//      production throws: a Prisma raw-query failure, a response-serialization failure, a Zod
//      querystring failure, a typed domain error, an error carrying a status under the WRONG
//      field name, and an invalid JSON body.
//   2. U-EH6..U-EH7 — the same through the REAL `buildApp` + the REAL gallery route, because a
//      handler that is never registered protects nothing, and "is it wired?" is not something
//      the isolated tests can see.
//
// The contract has two sides and both are asserted. A genuinely unexpected error must leak
// NOTHING — no Prisma code, no SQLSTATE, no offending literal, no stack, no internal message.
// An INTENTIONAL error must be answered exactly as it was before this handler existed, byte
// for byte, because half a dozen route suites assert those bodies.

const PRISMA_RAW_FAILURE_MESSAGE =
  "Invalid `prisma.$queryRaw()` invocation:\n\n" +
  "Raw query failed. Code: `22007`. Message: `ERROR: invalid input syntax for type " +
  'timestamp with time zone: "2026"`';

/** The exact object shape Prisma throws for a failed raw query. */
function prismaRawFailure(): Error {
  const err = new Error(PRISMA_RAW_FAILURE_MESSAGE) as Error & {
    code: string;
    clientVersion: string;
    meta: Record<string, unknown>;
  };
  err.name = "PrismaClientKnownRequestError";
  err.code = "P2010";
  err.clientVersion = "7.8.0";
  err.meta = { code: "22007", message: 'invalid input syntax … "2026"' };
  return err;
}

/** Every string that must never appear in a reply body. */
const SECRETS = [
  "P2010",
  "22007",
  "2026",
  "prisma",
  "Prisma",
  "$queryRaw",
  "timestamp with time zone",
  "invalid input syntax",
];

function expectLeakFree(body: string): void {
  for (const secret of SECRETS) {
    expect(body, `leaked: ${secret}`).not.toContain(secret);
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

/** A bare app with the handler registered and one probe route per failure mode. */
async function probeApp(opts: { handler?: boolean } = {}): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  if (opts.handler !== false) registerErrorHandler(instance);
  const r = instance.withTypeProvider<ZodTypeProvider>();

  const okSchema = { 200: z.object({ ok: z.boolean() }), 400: errorResponseSchema };

  r.get(
    "/validated",
    {
      schema: {
        querystring: z.object({ sort: z.enum(["popular", "newest"]).default("popular") }),
        response: okSchema,
      },
    },
    async () => ({ ok: true }),
  );
  r.get("/prisma", { schema: { response: okSchema } }, async () => {
    throw prismaRawFailure();
  });
  // A `rank` outside `z.number().int()` — exactly what a forged cursor ordinal produced.
  r.get(
    "/unserializable",
    { schema: { response: { 200: z.object({ rank: z.number().int() }) } } },
    async () => ({ rank: Number.MAX_SAFE_INTEGER + 1.5 }) as never,
  );
  r.get("/domain-409", { schema: { response: okSchema } }, async () => {
    class RenderNotPublishable extends Error {
      readonly statusCode = 409;
    }
    throw new RenderNotPublishable("render is queued, not completed");
  });
  r.get("/upstream-502", {}, async () => {
    const err = new Error("GitHub request failed: 401") as Error & { statusCode: number };
    err.statusCode = 502;
    throw err;
  });
  r.get("/status-field-401", {}, async () => {
    const err = new Error("Bad credentials") as Error & { status: number };
    err.status = 401;
    throw err;
  });
  r.get("/plain", {}, async () => {
    throw new Error("internal detail nobody outside should read");
  });
  r.post(
    "/body",
    { schema: { body: z.object({ a: z.string() }), response: okSchema } },
    async () => ({ ok: true }),
  );

  await instance.ready();
  return instance;
}

describe("the application error handler", () => {
  it("U-EH1: an UNEXPECTED error is a generic 500 that leaks no Prisma code, no SQLSTATE and no literal", async () => {
    // Without the handler this replied
    //   500 {"statusCode":500,"code":"P2010","error":"Internal Server Error",
    //        "message":"…Code: `22007`… timestamp with time zone: \"2026\"…"}
    // to an anonymous caller. The `handler: false` half below is that baseline, asserted so
    // this test cannot pass by the leak simply not existing.
    const leaky = await probeApp({ handler: false });
    const before = await leaky.inject({ method: "GET", url: "/prisma" });
    expect(before.statusCode).toBe(500);
    expect(before.body).toContain("P2010");
    expect(before.body).toContain("22007");
    await leaky.close();

    app = await probeApp();
    const res = await app.inject({ method: "GET", url: "/prisma" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(INTERNAL_ERROR_BODY);
    expectLeakFree(res.body);
  });

  it("U-EH2: a response-SERIALIZATION failure and a bare throw are generified too", async () => {
    app = await probeApp();

    // FST_ERR_RESPONSE_SERIALIZATION carries `statusCode: 500`, so "500 is never a contract"
    // is what catches it.
    const serialization = await app.inject({ method: "GET", url: "/unserializable" });
    expect(serialization.statusCode).toBe(500);
    expect(serialization.json()).toEqual(INTERNAL_ERROR_BODY);
    expect(serialization.body).not.toContain("FST_ERR");
    expect(serialization.body).not.toContain("schema");

    const plain = await app.inject({ method: "GET", url: "/plain" });
    expect(plain.statusCode).toBe(500);
    expect(plain.json()).toEqual(INTERNAL_ERROR_BODY);
    expect(plain.body).not.toContain("internal detail");
  });

  it("U-EH3: an error carrying its status under the WRONG field name no longer dictates the reply", async () => {
    // Fastify's default handler prefers `error.status` over `error.statusCode` — the trap
    // documented in `connections/github-app-client.ts`, where a GitHub 401 on a token exchange
    // became OUR 401 and told a caller with a fine session to sign in again.
    const leaky = await probeApp({ handler: false });
    const before = await leaky.inject({ method: "GET", url: "/status-field-401" });
    expect(before.statusCode).toBe(401);
    await leaky.close();

    app = await probeApp();
    const res = await app.inject({ method: "GET", url: "/status-field-401" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(INTERNAL_ERROR_BODY);
    expect(res.body).not.toContain("Bad credentials");
  });

  it("U-EH4: a VALIDATION 400 is answered byte-for-byte as it was before the handler existed", async () => {
    // Half a dozen route suites assert this body. If the handler rewrote it, every one of them
    // would be a contract change disguised as a fix.
    const withHandler = await probeApp();
    const without = await probeApp({ handler: false });
    try {
      for (const [method, url, payload] of [
        ["GET", "/validated?sort=hot", undefined],
        ["GET", "/validated?sort=", undefined],
        ["POST", "/body", "{not json"],
        ["POST", "/body", JSON.stringify({ a: 7 })],
        ["GET", "/nonexistent-route", undefined],
      ] as Array<[string, string, string | undefined]>) {
        const opts = {
          method: method as "GET",
          url,
          payload,
          headers: payload === undefined ? {} : { "content-type": "application/json" },
        };
        const a = await withHandler.inject(opts);
        const b = await without.inject(opts);
        expect(a.statusCode, `${method} ${url}`).toBe(b.statusCode);
        expect(a.body, `${method} ${url}`).toBe(b.body);
      }
      // …and the 400s really are 400s, so the equality above is not comparing two 500s.
      const bad = await withHandler.inject({ method: "GET", url: "/validated?sort=hot" });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message).toContain("querystring/sort");
    } finally {
      await withHandler.close();
      await without.close();
    }
  });

  it("U-EH5: a typed domain error's status and message survive — 409 and 502 alike", async () => {
    app = await probeApp();

    const conflict = await app.inject({ method: "GET", url: "/domain-409" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().message).toBe("render is queued, not completed");

    // 502 is an INTENTIONAL status in this codebase (`GithubAppRequestError`): "the upstream
    // failed" is a real distinction from "we broke", so it is preserved rather than flattened.
    const upstream = await app.inject({ method: "GET", url: "/upstream-502" });
    expect(upstream.statusCode).toBe(502);
    expect(upstream.json().message).toBe("GitHub request failed: 401");
  });
});

// ------------------------------------------------- actually wired into the real app

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
} as never;

/** The real `buildApp` with the real gallery route over a service that fails the way Postgres
 *  fails. Nothing here is a stand-in for the app under test. */
async function realApp(over: Partial<GalleryService>): Promise<FastifyInstance> {
  const service = {
    listGallery: async () => ({ items: [], nextCursor: null }),
    getItem: async () => {
      throw new Error("unused");
    },
    ...over,
  } as unknown as GalleryService;
  const instance = buildApp({
    auth: {
      authService: fakeAuthService,
      env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "0" },
    },
    gallery: { service },
  });
  await instance.ready();
  return instance;
}

describe("the error handler is registered by buildApp", () => {
  it("U-EH6: a Prisma raw-query failure inside GET /v1/gallery is a generic 500 on the REAL app", async () => {
    app = await realApp({
      listGallery: async () => {
        throw prismaRawFailure();
      },
    });
    const res = await app.inject({ method: "GET", url: "/v1/gallery" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual(INTERNAL_ERROR_BODY);
    expectLeakFree(res.body);
  });

  it("U-EH7: the real app's intentional 400s and 404s are untouched by it", async () => {
    app = await realApp({});
    // Zod boundary — the closed `sort` enum.
    const badSort = await app.inject({ method: "GET", url: "/v1/gallery?sort=hot" });
    expect(badSort.statusCode).toBe(400);
    expect(badSort.json().error).toBe("Bad Request");
    // An unmatched route still gets Fastify's own 404, not a generic 500.
    const missing = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(missing.statusCode).toBe(404);
    // And the happy path still works, so the handler is not swallowing successes.
    const ok = await app.inject({ method: "GET", url: "/v1/gallery" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ items: [], nextCursor: null });
  });
});
