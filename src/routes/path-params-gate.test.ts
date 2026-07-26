import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { isPostgresSafeText } from "../postgres-text";

/**
 * U-PP — THE ANTI-WHACK-A-MOLE TEST, and the only one in this repo that is about the whole
 * route table rather than one module.
 *
 * WHY IT EXISTS. Closing the gallery's `:id` hole (N2) fixed six routes. It did not fix the
 * NINE OTHER parameterised routes in this api, and a MEASURED sweep against real Postgres found
 * eight more 500s of the identical shape behind a valid session:
 *
 *   500  GET    /v1/projects/<NUL>              500  GET    /v1/renders/<NUL>
 *   500  PATCH  /v1/projects/<NUL>              500  POST   /v1/renders/<NUL>/cancel
 *   500  DELETE /v1/projects/<NUL>              500  GET    /v1/renders/<NUL>/download
 *   500  GET    /v1/projects/<NUL>/versions     500  GET    /v1/projects/<NUL>/jobs/<NUL>
 *
 * Patching those nine routes by hand would be the same mistake one scope wider: the next route
 * anybody adds inherits the hole. So the guard is STRUCTURAL and enumerated from the REAL route
 * table — every route Fastify knows about, discovered through `onRoute`, is required to have a
 * `params` schema that refuses an unsafe string in EVERY one of its path parameters.
 *
 * A new `/:someId` route with an ungated params schema fails this test on the day it is written,
 * which is the property the previous two passes were missing.
 *
 * It is a SCHEMA test, not an HTTP test: no database, no services, no handler ever runs. The
 * behavioural proof that the schema's rejection becomes a 400 lives in `gallery.test.ts`
 * (U-GR12) and in `tests/e2e/gallery.e2e.ts` (E-G20).
 */

/** Every route with a path parameter must refuse these. One per rejection reason. */
const UNSAFE = [
  ["NUL", String.fromCodePoint(0)],
  ["NUL embedded in a plausible id", `cms1${String.fromCodePoint(0)}xyz`],
  ["vertical tab", String.fromCodePoint(0x0b)],
  ["form feed", String.fromCodePoint(0x0c)],
  ["DEL", String.fromCodePoint(0x7f)],
  ["unpaired surrogate", String.fromCodePoint(0xd800)],
] as const;

/** ...and must still ACCEPT these, so the gate cannot be satisfied by rejecting everything. */
const SAFE = ["cms1rypc40004q2lg6gcxlivg", "no-such-item", "gal-e2e-tag-abc123", "0"] as const;

interface Captured {
  method: string;
  url: string;
  params: { safeParse: (v: unknown) => { success: boolean } } | undefined;
}

/**
 * Build the app with EVERY dependency section supplied, so every route registers.
 *
 * The services are never called — this test reads schemas off the route table — so empty
 * stand-ins are honest here rather than lazy. `env` is the one exception: the auth section
 * reads it during registration to gate the seed route.
 */
async function captureRoutes(): Promise<Captured[]> {
  const routes: Captured[] = [];
  const svc = { service: {} as never };
  let app: FastifyInstance | undefined;
  try {
    app = buildApp({
      auth: {
        authService: { authenticate: async () => null } as never,
        env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
      },
      github: svc,
      connections: { openrouter: {} as never, gloo: {} as never, reader: {} as never },
      files: svc,
      projects: svc,
      manifests: svc,
      projectJobs: svc,
      aiGenerations: svc,
      repoProvisioning: svc,
      renders: svc,
      gallery: svc,
    } as never);
    app.addHook("onRoute", (r) => {
      const method = Array.isArray(r.method) ? r.method.join(",") : String(r.method);
      routes.push({
        method,
        url: r.url,
        params: (r.schema as { params?: Captured["params"] } | undefined)?.params,
      });
    });
    await app.ready();
    return routes;
  } finally {
    if (app) await app.close();
  }
}

describe("U-PP: every parameterised route gates its path parameters", () => {
  it("finds a substantial route table — the enumeration is the whole guard, so it must not be empty", async () => {
    const routes = await captureRoutes();
    const parameterised = routes.filter((r) => r.url.includes(":") && r.method !== "HEAD");
    // Measured at the time of writing: 15 parameterised non-HEAD routes across six families.
    // A floor, not an exact count, so adding a route does not fail this assertion — it fails
    // the NEXT one, which is where the useful message is.
    expect(parameterised.length).toBeGreaterThanOrEqual(15);
    // If the wiring above ever silently stopped registering a section, this is the canary.
    for (const family of ["/projects/", "/renders/", "/gallery/", "/ai/generations/"]) {
      expect(
        parameterised.some((r) => r.url.includes(family)),
        `no parameterised route under ${family}`,
      ).toBe(true);
    }
  });

  it("EVERY parameterised route declares a params schema that REJECTS an unsafe string in EVERY parameter", async () => {
    const routes = await captureRoutes();
    const parameterised = routes.filter((r) => r.url.includes(":") && r.method !== "HEAD");
    const failures: string[] = [];

    for (const route of parameterised) {
      const names = [...route.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      const tag = `${route.method} ${route.url}`;
      if (!route.params) {
        failures.push(`${tag} has NO params schema at all`);
        continue;
      }
      for (const name of names) {
        for (const [label, unsafe] of UNSAFE) {
          // Every OTHER parameter is a legal value, so a rejection can only be about this one.
          const value = Object.fromEntries(
            names.map((n) => [n, n === name ? unsafe : "cms1rypc40004q2lg6gcxlivg"]),
          );
          if (route.params.safeParse(value).success) {
            failures.push(`${tag} ACCEPTS ${label} in :${name}`);
          }
        }
        for (const safe of SAFE) {
          const value = Object.fromEntries(
            names.map((n) => [n, n === name ? safe : "cms1rypc40004q2lg6gcxlivg"]),
          );
          if (!route.params.safeParse(value).success) {
            failures.push(`${tag} REJECTS the safe id ${JSON.stringify(safe)} in :${name}`);
          }
        }
      }
    }

    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  });

  it("the gate agrees with the shared predicate rather than re-deriving the rule", async () => {
    // Cross-check: everything in UNSAFE is unsafe by the shared rule and everything in SAFE is
    // safe by it, so this suite cannot pass while disagreeing with `postgres-text`.
    for (const [label, unsafe] of UNSAFE) {
      expect(isPostgresSafeText(unsafe), label).toBe(false);
    }
    for (const safe of SAFE) {
      expect(isPostgresSafeText(safe), safe).toBe(true);
    }
  });
});
