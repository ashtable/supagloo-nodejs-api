import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerAiModelRoutes } from "./ai-models";
import { AiModelCatalogueResponseSchema } from "../ai/model-catalogue-dto";
import type { AiModelInfo } from "../ai/model-catalogue";

/**
 * U-MC10/U-MC11 — the thin handler for `GET /v1/ai/models`.
 *
 * Two things are worth a route-level test rather than a service-level one:
 *
 *  - **It is per-user and must require a bearer.** The Gloo half of the catalogue is
 *    fetched with a token minted from the CALLER'S OWN client credentials, so an
 *    anonymous read would either leak whichever user the service happened to be asked
 *    about, or fail confusingly. `/v1` has no global auth hook — `bearerAuthPlugin` only
 *    decorates — so a missing `preHandler` here would silently make the route public.
 *  - **The response must satisfy the wire schema**, because the nextjs BFF hand-mirrors
 *    it (nextjs deliberately does not import db-lib) and a drift is otherwise invisible
 *    until a picker renders empty in a browser.
 */

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

const RESULT: {
  models: AiModelInfo[];
  providers: { gloo: boolean; openrouter: boolean };
} = {
  models: [
    {
      id: "vendor/img",
      provider: "openrouter" as const,
      label: "Vendor Image",
      kinds: ["image" as const],
      pricing: { perOutputImageToken: 0.00006 },
      voices: null,
    },
    {
      id: "gloo-vendor-flux",
      provider: "gloo" as const,
      label: "Vendor Flux",
      kinds: ["image" as const],
      pricing: null,
      voices: null,
    },
  ],
  providers: { gloo: true, openrouter: true },
};

let app: FastifyInstance | undefined;

async function build(
  read: (userId: string) => Promise<{
    models: AiModelInfo[];
    providers: { gloo: boolean; openrouter: boolean };
  }>,
) {
  const instance = Fastify();
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  await instance.register(async (v1) => {
    await v1.register(bearerAuthPlugin, { authService: fakeAuthService as never });
    registerAiModelRoutes(v1, { service: { read } as never });
  });
  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /ai/models", () => {
  it("U-MC10: 401 without a bearer — the catalogue is per-user, never public", async () => {
    const instance = await build(async () => RESULT);
    const res = await instance.inject({ method: "GET", url: "/ai/models" });
    expect(res.statusCode).toBe(401);
  });

  it("U-MC11: 200 with the catalogue for the AUTHENTICATED user", async () => {
    let sawUserId: string | null = null;
    const instance = await build(async (userId) => {
      sawUserId = userId;
      return RESULT;
    });
    const res = await instance.inject({
      method: "GET",
      url: "/ai/models",
      headers: { authorization: "Bearer valid" },
    });
    expect(res.statusCode).toBe(200);
    expect(sawUserId).toBe("u1");
    // Parsed, not shape-spotted: this is the contract the nextjs BFF mirrors.
    const parsed = AiModelCatalogueResponseSchema.safeParse(res.json());
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.models.map((m) => m.id)).toEqual([
        "vendor/img",
        "gloo-vendor-flux",
      ]);
      // `null` pricing must survive serialization as null — an unpriced model that
      // arrived as `{}` would be indistinguishable from one priced at zero.
      expect(parsed.data.models[1].pricing).toBeNull();
    }
  });

  it("U-MC11b: an empty catalogue is a 200 with an empty list, not a 404", async () => {
    // The Inspector renders "no models available" from this; a 404 would surface as a
    // failed read and take the whole provider picker down with it.
    const instance = await build(async () => ({
      models: [],
      providers: { gloo: false, openrouter: true },
    }));
    const res = await instance.inject({
      method: "GET",
      url: "/ai/models",
      headers: { authorization: "Bearer valid" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      models: [],
      providers: { gloo: false, openrouter: true },
    });
  });

  it("U-MC12: the SERIALIZER does not strip `supported_voices`", async () => {
    // THE strip point. Fastify's zod serializer runs the response through
    // `AiModelCatalogueResponseSchema`, and a `z.object` drops unknown keys — so adding
    // `voices` to the service and the mapper without adding it to the DTO yields exactly
    // nothing on the wire, silently, with every service-level test still green. This is
    // the boundary the four-mirror rule does not name and no other repo's suite can see.
    //
    // Asserted against the RAW body rather than the parsed one: parsing with the same
    // schema that does the stripping is agreement, not proof.
    const instance = await build(async () => ({
      models: [
        {
          id: "hexgrad/kokoro-82m",
          provider: "openrouter" as const,
          label: "hexgrad: Kokoro 82M",
          kinds: ["narration" as const],
          pricing: null,
          voices: ["af_alloy", "am_adam"],
        },
        RESULT.models[0],
      ],
      providers: { gloo: false, openrouter: true },
    }));
    const res = await instance.inject({
      method: "GET",
      url: "/ai/models",
      headers: { authorization: "Bearer valid" },
    });
    expect(res.statusCode).toBe(200);
    const raw = JSON.parse(res.body) as {
      models: Array<{ id: string; voices: unknown }>;
    };
    expect(raw.models[0].voices).toEqual(["af_alloy", "am_adam"]);
    // And `null` survives as null rather than being dropped to `undefined`, which would
    // make an unpublished vocabulary indistinguishable from a stripped one.
    expect(raw.models[1]).toHaveProperty("voices", null);
  });
});
