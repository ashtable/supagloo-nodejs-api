import { describe, it, expect, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app";

// Non-UI e2e: boot the REAL server (real listen on an ephemeral port) and hit it
// with a real HTTP fetch over the loopback socket — proves the server binds and
// serves, beyond the in-process `inject` unit test. No docker, no browser.
describe("e2e: real HTTP GET /healthz", () => {
  let app: FastifyInstance | undefined;

  afterAll(async () => {
    if (app) await app.close();
  });

  it("serves 200 {status:'ok'} over a real socket", async () => {
    app = buildApp();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const res = await fetch(`${address}/healthz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
