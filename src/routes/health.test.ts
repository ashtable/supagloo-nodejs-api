import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";

describe("GET /healthz", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("returns 200 with a minimal liveness body", async () => {
    app = buildApp();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("wires the zod serializer (strips keys not in the response schema)", async () => {
    // A zod response schema cannot be compiled by Fastify without the zod
    // serializerCompiler set by buildApp() — this route working AND stripping
    // the extra `b` key proves the type provider is active.
    app = buildApp();
    app.withTypeProvider<ZodTypeProvider>().get(
      "/__serializer_probe",
      { schema: { response: { 200: z.object({ a: z.string() }) } } },
      async () => ({ a: "kept", b: "stripped" }) as { a: string },
    );
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/__serializer_probe" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ a: "kept" });
  });
});
