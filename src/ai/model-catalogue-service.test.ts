import { describe, expect, it, vi } from "vitest";
import { ModelCatalogueService } from "./model-catalogue-service";

/**
 * U-MC6..U-MC9 — the orchestration half: four upstream catalogues, one user, one answer.
 *
 * The properties that matter are all about DEGRADATION, because this endpoint sits in
 * front of a UI control. If it throws, the Inspector has no provider picker and no cost
 * row at all; if it lies, the user picks a model that cannot run. So:
 *
 *  - a user with no Gloo connection still gets the OpenRouter half (200, not 401/500);
 *  - one dead upstream costs its own provider's models, never the whole response;
 *  - an empty catalogue is an empty list, never a throw;
 *  - repeated reads inside the TTL do not re-hit four upstreams per keystroke.
 *
 * Injected `fetch` throughout, hand-built `Response`, no mocking library — the repo's
 * provider-client convention.
 */

const OPENROUTER_CHAT = JSON.stringify({
  data: [
    {
      id: "vendor/img",
      name: "Vendor Image",
      architecture: { output_modalities: ["image"] },
      pricing: { prompt: "0.0000005", completion: "0.000002", image: "0.03" },
    },
    {
      id: "vendor/txt",
      name: "Vendor Text",
      architecture: { output_modalities: ["text"] },
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
    },
  ],
});
const OPENROUTER_SPEECH = JSON.stringify({
  data: [{ id: "vendor/tts", pricing: { prompt: "0.000004", completion: "0" } }],
});
// A SEPARATE catalogue from `…=speech`, sharing no id with it. Verified live 2026-07-28:
// `?output_modalities=audio` returns 4 entries (both Lyria music models + two chat-audio
// models) and `?output_modalities=speech` returns 15 batch-TTS models, with an empty
// intersection.
const OPENROUTER_AUDIO = JSON.stringify({
  data: [
    { id: "vendor/lyria", name: "Vendor Lyria", pricing: { prompt: "0", completion: "0" } },
    {
      id: "vendor/gpt-audio",
      pricing: { prompt: "0.0000025", completion: "0.00001", audio: "0.000032" },
    },
  ],
});
const OPENROUTER_VIDEO = JSON.stringify({
  data: [{ id: "vendor/video", description: "text-to-video", supported_durations: [4] }],
});
const GLOO_TOKEN = JSON.stringify({ access_token: "t", expires_in: 3600 });
const GLOO_MODELS = JSON.stringify({
  object: "list",
  data: [
    {
      id: "gloo-vendor-flux",
      name: "Vendor Flux",
      output_modalities: ["image"],
      pricing: { output: { rate_per_1k_tokens: "0.004560" } },
    },
    {
      id: "gloo-vendor-chat",
      output_modalities: ["text"],
      pricing: {
        input: { rate_per_1k_tokens: "0.000100" },
        output: { rate_per_1k_tokens: "0.000400" },
      },
    },
  ],
});

/** Route an injected fetch by URL, recording every call. */
function router(
  overrides: Partial<Record<string, () => Response>> = {},
): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    for (const [needle, make] of Object.entries(overrides)) {
      if (u.includes(needle)) return make!();
    }
    if (u.includes("/oauth2/token")) return new Response(GLOO_TOKEN, { status: 200 });
    if (u.includes("/platform/v2/models")) return new Response(GLOO_MODELS, { status: 200 });
    if (u.includes("/api/v1/videos/models")) return new Response(OPENROUTER_VIDEO, { status: 200 });
    if (u.includes("output_modalities=speech")) return new Response(OPENROUTER_SPEECH, { status: 200 });
    if (u.includes("output_modalities=audio")) return new Response(OPENROUTER_AUDIO, { status: 200 });
    if (u.includes("/api/v1/models")) return new Response(OPENROUTER_CHAT, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const MATRIX = {
  storyboard: ["gloo", "openrouter"],
  script: ["gloo", "openrouter"],
  image: ["gloo", "openrouter"],
  narration: ["openrouter"],
  music: ["openrouter"],
  video: ["openrouter"],
} as const;

function makeService(opts: {
  fetchImpl: typeof fetch;
  gloo?: { clientId: string; clientSecret: string } | null;
  openrouter?: boolean | (() => Promise<boolean>);
  now?: () => number;
}) {
  const or = opts.openrouter ?? true;
  return new ModelCatalogueService({
    openrouterBaseUrl: "https://openrouter.example.invalid",
    glooBaseUrl: "https://platform.example.invalid",
    fetchImpl: opts.fetchImpl,
    matrix: MATRIX,
    now: opts.now,
    hasOpenRouterConnection: typeof or === "function" ? or : async () => or,
    // The credential loader is the whole reason this endpoint lives in the api rather
    // than the BFF: Gloo's catalogue needs a bearer minted from the user's client
    // credentials, which are encrypted at rest in this service's own database.
    loadGlooCredential: vi.fn(async () =>
      opts.gloo === undefined
        ? { clientId: "cid", clientSecret: "sec" }
        : opts.gloo,
    ),
  });
}

describe("ModelCatalogueService", () => {
  it("returns both providers' models, filtered by the compatibility matrix", async () => {
    const rec = router();
    const result = await makeService({ fetchImpl: rec.fetch }).read("user-1");

    expect(result.providers).toEqual({ gloo: true, openrouter: true });
    const ids = result.models.map((m) => m.id).sort();
    // `gloo-vendor-chat` and `vendor/txt` are text-only and are deliberately ABSENT: the
    // Inspector has selectors for image/narration/music/video only, so a text-only entry
    // can never be rendered. On the live catalogues that is 338 of 364 entries.
    expect(ids).toEqual([
      "gloo-vendor-flux",
      "vendor/gpt-audio",
      "vendor/img",
      "vendor/lyria",
      "vendor/tts",
      "vendor/video",
    ]);
    // The matrix bites here: a Gloo model may serve `image`, never `narration`.
    expect(result.models.find((m) => m.id === "gloo-vendor-flux")?.kinds).toEqual([
      "image",
    ]);
  });

  it("U-MC6b: `providers.openrouter` reports the real connection, not a constant", async () => {
    // It used to be a hardcoded `true`, which contradicted the field's own definition:
    // both this DTO's JSDoc and the nextjs mirror (`lib/api/contracts.ts`) say "whether
    // the caller has each provider CONNECTED", and half the answer was a constant. The
    // Gloo half was already honest, so the shape was also internally inconsistent.
    //
    // Be precise about the blast radius, because it is smaller than it looks: today's
    // Inspector does NOT read this field to decide between offering OpenRouter and
    // offering a `Link ▸`. `ai-settings-panel.tsx` derives that from `session.connections`
    // (see `providerOptionsFor`), and `catalogue.providers` is parsed and stored on
    // `state.modelCatalogue` without a consumer. So this fixes a wire contract that was
    // stating something false, not a visible bug — and it does it before the next reader
    // trusts the field, which is exactly when a lying constant becomes one.
    const rec = router();
    expect(
      (await makeService({ fetchImpl: rec.fetch, openrouter: false }).read("u")).providers,
    ).toEqual({ gloo: true, openrouter: false });
    expect(
      (await makeService({ fetchImpl: rec.fetch, openrouter: true }).read("u2")).providers,
    ).toEqual({ gloo: true, openrouter: true });
  });

  it("U-MC6c: a thrown OpenRouter connection read degrades to `false`, never a 500", async () => {
    // Same containment rule as everywhere else here, and the same direction as the Gloo
    // half: an unreadable connection degrades to not-connected. The alternative — letting
    // it reject the whole response — costs the picker entirely, which is why the second
    // assertion is here: the models must still arrive.
    const rec = router();
    const result = await makeService({
      fetchImpl: rec.fetch,
      openrouter: async () => {
        throw new Error("db down");
      },
    }).read("u");
    expect(result.providers.openrouter).toBe(false);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("U-MC6d: the narration and music id sets are DISJOINT — two catalogues, not one", async () => {
    // The defect this pins: the service used to read only `?output_modalities=speech` and
    // stamp every entry `kinds:["narration","music"]`, so the MUSIC selector offered 15
    // batch-TTS ids and nothing else. `generateAudio` dispatches by kind — narration goes
    // to `requestSpeech` (`POST /api/v1/audio/speech`), music goes to `requestMusic` (the
    // streaming `POST /api/v1/chat/completions`) — so choosing one of those sent a
    // speech-only id to the chat endpoint. Live, the two catalogues share NO id.
    const rec = router();
    const result = await makeService({ fetchImpl: rec.fetch }).read("u");

    const narration = result.models.filter((m) => m.kinds.includes("narration"));
    const music = result.models.filter((m) => m.kinds.includes("music"));
    expect(narration.map((m) => m.id)).toEqual(["vendor/tts"]);
    expect(music.map((m) => m.id).sort()).toEqual(["vendor/gpt-audio", "vendor/lyria"]);
    expect(
      narration.filter((n) => music.some((m) => m.id === n.id)),
    ).toEqual([]);
    // And the fourth read is a real, separate round trip.
    expect(rec.calls.filter((c) => c.includes("output_modalities=audio"))).toHaveLength(1);
  });

  it("U-MC6e: a dead audio catalogue costs the music options ONLY", async () => {
    const rec = router({
      "output_modalities=audio": () => new Response("boom", { status: 500 }),
    });
    const result = await makeService({ fetchImpl: rec.fetch }).read("u");
    expect(result.models.some((m) => m.kinds.includes("music"))).toBe(false);
    expect(result.models.some((m) => m.kinds.includes("narration"))).toBe(true);
    expect(result.models.some((m) => m.kinds.includes("image"))).toBe(true);
  });

  it("U-MC6: no Gloo connection ⇒ Gloo models absent, OpenRouter models still returned", async () => {
    const rec = router();
    const result = await makeService({ fetchImpl: rec.fetch, gloo: null }).read("u");

    expect(result.providers.gloo).toBe(false);
    expect(result.models.every((m) => m.provider === "openrouter")).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
    // And no pointless round trip to a provider we have no credential for.
    expect(rec.calls.some((c) => c.includes("/oauth2/token"))).toBe(false);
  });

  it("U-MC7a: a dead Gloo upstream degrades to zero Gloo models, not a failed request", async () => {
    const rec = router({
      "/platform/v2/models": () => new Response("boom", { status: 500 }),
    });
    const result = await makeService({ fetchImpl: rec.fetch }).read("u");

    expect(result.models.every((m) => m.provider === "openrouter")).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
    // `providers.gloo` reports the CONNECTION, not the read. The user is connected; the
    // catalogue read failed. Conflating them would make the Inspector say "connect Gloo"
    // to someone who already has.
    expect(result.providers.gloo).toBe(true);
  });

  it("U-MC7b: one dead OpenRouter sub-catalogue does not take the other two with it", async () => {
    const rec = router({
      "/api/v1/videos/models": () => new Response("boom", { status: 503 }),
    });
    const result = await makeService({ fetchImpl: rec.fetch }).read("u");

    expect(result.models.some((m) => m.kinds.includes("video"))).toBe(false);
    expect(result.models.some((m) => m.kinds.includes("image"))).toBe(true);
    expect(result.models.some((m) => m.kinds.includes("narration"))).toBe(true);
  });

  it("U-MC7c: a thrown fetch (network down) is still a 200-shaped answer", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await makeService({ fetchImpl }).read("u");
    expect(result.models).toEqual([]);
  });

  it("U-MC8: an EMPTY catalogue is an empty list, not a throw", async () => {
    const rec = router({
      "/api/v1/models": () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      "/api/v1/videos/models": () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      "/platform/v2/models": () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
    });
    const result = await makeService({ fetchImpl: rec.fetch }).read("u");
    expect(result.models).toEqual([]);
  });

  it("U-MC8b: a malformed catalogue body degrades to empty rather than throwing", async () => {
    const rec = router({
      "/platform/v2/models": () => new Response("<html>nope</html>", { status: 200 }),
    });
    const result = await makeService({ fetchImpl: rec.fetch }).read("u");
    expect(result.models.every((m) => m.provider === "openrouter")).toBe(true);
  });

  it("U-MC9: a second read inside the TTL serves from cache; past it, it refetches", async () => {
    // The Inspector reads this on every studio open. Four upstream round trips per open
    // (three OpenRouter catalogues + a Gloo mint + catalogue) is enough egress to matter,
    // and the catalogue changes on the order of days.
    let clock = 1_000_000;
    const rec = router();
    const service = makeService({ fetchImpl: rec.fetch, now: () => clock });

    await service.read("u");
    const afterFirst = rec.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await service.read("u");
    expect(rec.calls.length).toBe(afterFirst);

    clock += 10 * 60_000 + 1;
    await service.read("u");
    expect(rec.calls.length).toBeGreaterThan(afterFirst);
  });

  it("U-MC9b: the cache is PER USER — one user's Gloo catalogue is never served to another", async () => {
    // Gloo's catalogue is fetched with the caller's OWN minted bearer. A shared cache key
    // would leak whatever provider entitlements one account has to every other account.
    let clock = 1_000_000;
    const rec = router();
    const service = makeService({ fetchImpl: rec.fetch, now: () => clock });

    await service.read("user-a");
    const afterA = rec.calls.length;
    await service.read("user-b");
    expect(rec.calls.length).toBeGreaterThan(afterA);
  });
});
