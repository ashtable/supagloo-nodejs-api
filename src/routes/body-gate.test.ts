import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";

/**
 * U-BG — THE BODY-SCHEMA INVENTORY, and the honest twin of `path-params-gate.test.ts`.
 *
 * WHY IT IS AN INVENTORY AND NOT A GATE. Its sibling requires EVERY parameterised route to
 * refuse an unsafe path parameter, and it can, because path parameters are gated api-wide.
 * Bodies are not: exactly ONE of this api's fourteen `body` schemas passes through
 * `../postgres-text`, and widening the gate to the other thirteen would change the error
 * contract of seven route files that this run — a gallery task, plan rows 39/40/41 — never
 * reviewed, never measured and never tested, including the bodies that carry OpenRouter
 * keys, Gloo credentials and YouVersion tokens. Doing that quietly as a side effect of a
 * documentation fix is exactly the sort of scope creep the `preValidation`-hook decision
 * already rejected.
 *
 * So the doc in `../postgres-text` states the scope, and this file HOLDS that statement to
 * the real route table:
 *
 *   1. the set of routes declaring a body is exactly the documented set, so a new body
 *      route cannot join it silently — whoever adds one has to come here, look at the two
 *      lists, and make an explicit choice;
 *   2. the ONE route documented as gated really does refuse an unsafe string in a
 *      STRUCTURALLY VALID body, and really does still accept the same body clean.
 *
 * WHAT IT DOES NOT PROVE, stated plainly rather than implied: it does not measure the
 * thirteen ungated bodies against Postgres, and it does not assert they are ungated. It
 * asserts what the code IS, and makes the list impossible to fall behind. When those bodies
 * get their own task, the UNGATED list here shrinks to `[]` and this file becomes the gate
 * its sibling already is.
 */

/**
 * The ONE body schema wrapped in `withPostgresSafeStrings` (`routes/gallery.ts`).
 * `${method} ${url}` as Fastify spells it.
 */
const GATED = ["POST /v1/renders/:id/gallery"] as const;

/**
 * Every OTHER route declaring a body. Deliberately spelled out: this list is the scope
 * paragraph in `../postgres-text`, and a diff to it is the moment somebody decides whether
 * a new body belongs on this side of the line.
 */
const UNGATED = [
  "POST /v1/auth/youversion",
  "POST /v1/ai/generations",
  "POST /v1/connections/openrouter",
  "PUT /v1/connections/gloo",
  "POST /v1/connections/github/callback",
  // Its only string is a GitHub authorization code — spent against GitHub and
  // discarded, never written to Postgres. See `../postgres-text`'s scope paragraph.
  "POST /v1/connections/github/link-existing",
  "POST /v1/projects/:id/renders",
  "POST /v1/projects",
  "POST /v1/projects/import",
  "POST /v1/projects/:id/commit",
  "POST /v1/projects/:id/publish",
  "PATCH /v1/projects/:id",
  "POST /v1/projects/create-repo",
  "POST /v1/test/seed",
] as const;

interface Captured {
  key: string;
  body: { safeParse: (v: unknown) => { success: boolean } } | undefined;
}

/**
 * Build the app with EVERY dependency section wired, so every route registers. The services
 * are never called — this test reads schemas off the route table, exactly as its sibling
 * does — so empty stand-ins are honest here. `env` is the one exception: the auth section
 * reads it during registration to gate the seed route.
 */
async function captureBodyRoutes(): Promise<Captured[]> {
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
      const body = (r.schema as { body?: Captured["body"] } | undefined)?.body;
      if (body) routes.push({ key: `${method} ${r.url}`, body });
    });
    await app.ready();
    return routes;
  } finally {
    if (app) await app.close();
  }
}

/** A structurally valid publish body — the ONE body this repo builds by hand, because it is
 *  the ONE it gates. `over` replaces a single field with the hostile value. */
const publishBody = (over: Record<string, unknown> = {}) => ({
  title: "He Who Dwells",
  description: "Psalm 91 in nine scenes.",
  scriptureReference: "Psalm 91:1",
  translation: "BSB",
  visibility: "public",
  ...over,
});

describe("U-BG: the api's body schemas, and which of them carry the Postgres-text gate", () => {
  it("the routes declaring a body are EXACTLY the documented set — nothing joins it silently", async () => {
    const found = (await captureBodyRoutes()).map((r) => r.key).sort();
    const documented = [...GATED, ...UNGATED].sort();
    // A plain set comparison, so the failure message names the route that appeared or
    // vanished. If it names a NEW route: either wrap its body with
    // `withPostgresSafeStrings` and add it to GATED, or add it to UNGATED and say why in
    // `../postgres-text`'s scope paragraph. Both are decisions; neither is a default.
    expect(found).toEqual(documented);
  });

  it("the ONE gated body refuses an unsafe string in a structurally valid payload — in EVERY string field", async () => {
    const routes = await captureBodyRoutes();
    const publish = routes.find((r) => r.key === GATED[0]);
    if (!publish?.body) throw new Error(`${GATED[0]} declares no body schema`);

    // The clean body must PASS, or "it rejects a NUL" would be satisfied by a schema that
    // rejects everything.
    expect(publish.body.safeParse(publishBody()).success).toBe(true);

    // ...and every string field must be covered, because the gate WALKS the parsed value
    // rather than naming fields. A per-field check is what let the cursor's fourth field
    // through the previous pass.
    for (const field of [
      "title",
      "description",
      "scriptureReference",
      "translation",
    ]) {
      for (const [label, unsafe] of [
        ["NUL", String.fromCodePoint(0)],
        ["NUL embedded mid-string", `Psalm${String.fromCodePoint(0)}91`],
        ["vertical tab", String.fromCodePoint(0x0b)],
        ["DEL", String.fromCodePoint(0x7f)],
        ["unpaired surrogate", String.fromCodePoint(0xd800)],
      ] as const) {
        expect(
          publish.body.safeParse(publishBody({ [field]: unsafe })).success,
          `${GATED[0]} ACCEPTS ${label} in ${field}`,
        ).toBe(false);
      }
    }
  });

  it("the UNGATED list is a scope statement, not an empty formality — it is the work still open", async () => {
    // If this ever reads zero, the bodies got their own task and the first test above became
    // a real gate. Until then the number is the honest size of the gap, and it must match
    // what `../postgres-text` tells a reader.
    //
    // Not all 14 are the same kind of open work. `POST /v1/connections/github/link-existing`
    // is ungated because it has NOTHING to gate — its one string is a GitHub authorization
    // code that never reaches Postgres — so closing the gap would not shrink this list by
    // one; it would leave that route exactly where it is.
    expect(UNGATED.length).toBe(14);
    expect(GATED.length + UNGATED.length).toBe(15);
  });
});
