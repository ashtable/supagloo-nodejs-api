import { describe, expect, it } from "vitest";
import {
  filterByMatrix,
  kindsForGlooModel,
  narrowToSelectableKinds,
  kindsForOpenRouterModel,
  toGlooCatalogueEntry,
  toOpenRouterAudioEntry,
  toOpenRouterCatalogueEntry,
  toOpenRouterSpeechEntry,
  toOpenRouterVideoEntry,
  type AiModelInfo,
} from "./model-catalogue";

/**
 * U-MC1..U-MC5 — the PURE half of the model catalogue: turning two providers' very
 * different catalogue shapes into one list the studio can render a picker and a cost
 * estimate from.
 *
 * Everything asserted here was measured against the live hosts on 2026-07-28, because
 * two of the shipped comments in this codebase about these catalogues turned out to be
 * false and neither was discoverable by reading docs.
 *
 * The rules that carry real risk, and why:
 *
 *  - **A NEGATIVE price means variable/auto-priced on OpenRouter**, not "cheap". Treating
 *    it as a number would put a negative dollar amount in front of the user.
 *  - **A ZERO `pricing.image` is not free, it is broken.** Zero-priced "free" image models
 *    return 500 on real OpenRouter; a positive `pricing.image` is the reliability signal.
 *    Rendering "$0.00" would advertise a model that cannot work.
 *  - **Gloo's rates are decimal STRINGS per 1k tokens**, OpenRouter's are per token. They
 *    have to be normalized to the same unit or the two providers' costs are silently off
 *    by 1000x.
 *  - **Gloo image models do not serve chat.** `output_modalities` is the only reliable
 *    discriminator; the id substrings are not (four image models match the "cheap tier"
 *    name heuristic this repo used to rely on).
 */

describe("toOpenRouterCatalogueEntry (U-MC1, U-MC2)", () => {
  it("U-MC1: an image-capable entry with a positive per-image price is priced per image", () => {
    const entry = toOpenRouterCatalogueEntry({
      id: "vendor/img",
      name: "Vendor Image",
      architecture: { output_modalities: ["image"] },
      pricing: { prompt: "0.0000005", completion: "0.000002", image: "0.03" },
    });
    expect(entry).toEqual<AiModelInfo>({
      id: "vendor/img",
      provider: "openrouter",
      label: "Vendor Image",
      kinds: ["image"],
      pricing: { perImage: 0.03, perInputToken: 0.0000005, perOutputToken: 0.000002 },
    });
  });

  it("U-MC2a: a NEGATIVE price is variable/auto-priced and is dropped, not negated", () => {
    const entry = toOpenRouterCatalogueEntry({
      id: "vendor/auto",
      architecture: { output_modalities: ["image"] },
      pricing: { prompt: "-1", completion: "-1", image: "-1" },
    });
    expect(entry.pricing).toBeNull();
  });

  it("U-MC2b: a ZERO per-image price is dropped — a 'free' image model 500s in practice", () => {
    const entry = toOpenRouterCatalogueEntry({
      id: "vendor/free-img",
      architecture: { output_modalities: ["image"] },
      pricing: { prompt: "0", completion: "0", image: "0" },
    });
    expect(entry.pricing?.perImage).toBeUndefined();
  });

  it("U-MC2c: a missing pricing block yields null pricing, never a fabricated zero", () => {
    expect(
      toOpenRouterCatalogueEntry({
        id: "vendor/x",
        architecture: { output_modalities: ["text"] },
      }).pricing,
    ).toBeNull();
  });

  it("falls back to the id when the catalogue publishes no display name", () => {
    expect(
      toOpenRouterCatalogueEntry({
        id: "vendor/x",
        architecture: { output_modalities: ["text"] },
      }).label,
    ).toBe("vendor/x");
  });
});

describe("kindsForOpenRouterModel (U-MC1)", () => {
  it("maps output modalities to the generation kinds the studio can request", () => {
    expect(kindsForOpenRouterModel(["text"])).toEqual(["storyboard", "script"]);
    expect(kindsForOpenRouterModel(["image"])).toEqual(["image"]);
    expect(kindsForOpenRouterModel(["image", "text"]).sort()).toEqual(
      ["image", "script", "storyboard"].sort(),
    );
  });

  it("an unknown/absent modality yields NO kinds rather than a guess", () => {
    // A model we cannot place must not end up in a picker where choosing it would
    // produce a 400 from the provider three minutes later.
    expect(kindsForOpenRouterModel([])).toEqual([]);
    expect(kindsForOpenRouterModel(["embedding"])).toEqual([]);
  });
});

describe("toOpenRouterSpeechEntry / toOpenRouterAudioEntry / toOpenRouterVideoEntry (U-MC1)", () => {
  it("a speech-catalogue entry is the `narration` kind ONLY, priced on `prompt`", () => {
    // The dedicated `output_modalities=speech` catalogue prices on `prompt` with
    // `completion: "0"` — a different rule from the chat-audio models, which price on
    // `audio`/`completion`. Verified live 2026-07-27.
    const entry = toOpenRouterSpeechEntry({
      id: "vendor/tts",
      pricing: { prompt: "0.000004", completion: "0" },
    });
    expect(entry.kinds).toEqual(["narration"]);
    expect(entry.pricing).toEqual({ perInputToken: 0.000004 });
  });

  it("U-MC1c: a speech entry is NEVER offered for `music`", () => {
    // This is the whole point of the two-catalogue split. `generateAudio` dispatches by
    // kind: narration → `requestSpeech` → `POST /api/v1/audio/speech`; music →
    // `requestMusic` → the streaming `POST /api/v1/chat/completions`. A batch-TTS model
    // stamped `music` would be offered in the music picker and then handed to an endpoint
    // it does not serve — a real 400, minutes after the user chose it.
    expect(toOpenRouterSpeechEntry({ id: "vendor/tts" }).kinds).not.toContain("music");
  });

  it("U-MC1d: an audio-catalogue entry is the `music` kind, priced across all three fields", () => {
    // `GET /api/v1/models?output_modalities=audio` is a SEPARATE catalogue from
    // `…=speech`. Verified live 2026-07-28: it returns 4 entries — both Lyria music
    // models and the two chat-audio models — and shares no id with the 15-entry speech
    // catalogue. The chat-audio models price on `audio`/`completion`, so all three fields
    // are consulted, exactly as for speech.
    const entry = toOpenRouterAudioEntry({
      id: "vendor/gpt-audio",
      name: "Vendor Audio",
      pricing: { prompt: "0.0000025", completion: "0.00001", audio: "0.000032" },
    });
    expect(entry.kinds).toEqual(["music"]);
    expect(entry.provider).toBe("openrouter");
    expect(entry.label).toBe("Vendor Audio");
    expect(entry.pricing).toEqual({
      perInputToken: 0.0000025,
      perOutputToken: 0.00001,
    });
  });

  it("U-MC1e: an all-zero audio price is UNPRICED, never free", () => {
    // Live, both Lyria models publish `{prompt:"0", completion:"0"}`. Rendering that as
    // `$0.0000` would tell the user a music generation is free. `null` pricing makes the
    // cost row say "This model publishes no pricing", which is the true statement.
    expect(
      toOpenRouterAudioEntry({
        id: "vendor/lyria",
        pricing: { prompt: "0", completion: "0" },
      }).pricing,
    ).toBeNull();
  });

  it("U-MC1b: a VIDEO entry carries NO pricing at all — OpenRouter publishes none", () => {
    // `/api/v1/videos/models` exposes `supported_durations` and a text-to-video vs
    // image-to-video distinction, and no price field of any kind. This is the fact that
    // forces item 3's cost estimate to degrade honestly instead of inventing a number.
    const entry = toOpenRouterVideoEntry({
      id: "vendor/video",
      description: "text-to-video",
      supported_durations: [4, 8],
    });
    expect(entry.kinds).toEqual(["video"]);
    expect(entry.pricing).toBeNull();
  });
});

describe("toGlooCatalogueEntry (U-MC3, U-MC5)", () => {
  it("U-MC3a: an image-only Gloo entry is the `image` kind", () => {
    const entry = toGlooCatalogueEntry({
      id: "gloo-vendor-flux",
      name: "Vendor Flux",
      output_modalities: ["image"],
      pricing: { output: { rate_per_1k_tokens: "0.004560" } },
    });
    expect(entry.provider).toBe("gloo");
    expect(entry.kinds).toEqual(["image"]);
    expect(entry.label).toBe("Vendor Flux");
  });

  it("U-MC3b: a text-only Gloo entry is the two text kinds", () => {
    expect(kindsForGlooModel(["text"])).toEqual(["storyboard", "script"]);
  });

  it("U-MC3c: a text+image Gloo entry serves all three", () => {
    expect(kindsForGlooModel(["image", "text"]).sort()).toEqual(
      ["image", "script", "storyboard"].sort(),
    );
  });

  it("U-MC3d: Gloo NEVER produces narration/music/video kinds, whatever it publishes", () => {
    // The negative half of the live probe: zero catalogue entries match
    // audio|speech|tts|voice|narrat|music|video, and those routes answer 404 (route
    // absent) rather than 405. This assertion is what stops a future catalogue field
    // from silently offering a Gloo option the workflows cannot serve.
    for (const modalities of [["audio"], ["video"], ["speech"], ["text", "audio"]]) {
      const kinds = kindsForGlooModel(modalities);
      expect(kinds, modalities.join("+")).not.toContain("narration");
      expect(kinds, modalities.join("+")).not.toContain("music");
      expect(kinds, modalities.join("+")).not.toContain("video");
    }
  });

  it("U-MC5: Gloo's per-1K decimal STRING rates become per-TOKEN numbers", () => {
    // The correction to `e2e-models.ts`'s "no reliable per-model pricing": it is present
    // on 106/106 models. Normalizing to per token is what makes a Gloo price comparable
    // with an OpenRouter one — otherwise the two are silently 1000x apart.
    const entry = toGlooCatalogueEntry({
      id: "gloo-vendor-chat",
      output_modalities: ["text"],
      pricing: {
        input: { rate_per_1k_tokens: "0.000100" },
        output: { rate_per_1k_tokens: "0.000400" },
      },
    });
    expect(entry.pricing?.perInputToken).toBeCloseTo(0.0000001, 12);
    expect(entry.pricing?.perOutputToken).toBeCloseTo(0.0000004, 12);
    expect(entry.pricing?.perImage).toBeUndefined();
  });

  it("tolerates a catalogue entry with no pricing block", () => {
    expect(
      toGlooCatalogueEntry({ id: "gloo-vendor-chat", output_modalities: ["text"] })
        .pricing,
    ).toBeNull();
  });
});

describe("filterByMatrix (U-MC4)", () => {
  const models: AiModelInfo[] = [
    { id: "g-img", provider: "gloo", label: "g-img", kinds: ["image"], pricing: null },
    {
      id: "g-txt",
      provider: "gloo",
      label: "g-txt",
      kinds: ["storyboard", "script"],
      pricing: null,
    },
    {
      id: "or-img",
      provider: "openrouter",
      label: "or-img",
      kinds: ["image"],
      pricing: null,
    },
    {
      id: "or-tts",
      provider: "openrouter",
      label: "or-tts",
      kinds: ["narration", "music"],
      pricing: null,
    },
  ];

  it("U-MC4a: drops kinds a provider is not allowed to serve, per the INJECTED matrix", () => {
    // The matrix is injected rather than read straight from db-lib so this test pins the
    // RULE ("filter by whatever the matrix says") independently of the value db-lib
    // happens to carry at the currently-pinned submodule commit. The value itself is
    // pinned in db-lib by U-MX1, where it belongs.
    const matrix = {
      storyboard: ["gloo", "openrouter"],
      script: ["gloo", "openrouter"],
      image: ["gloo", "openrouter"],
      narration: ["openrouter"],
      music: ["openrouter"],
      video: ["openrouter"],
    } as const;

    const filtered = filterByMatrix(models, matrix);
    expect(filtered.find((m) => m.id === "g-img")?.kinds).toEqual(["image"]);
    expect(filtered.find((m) => m.id === "or-tts")?.kinds).toEqual([
      "narration",
      "music",
    ]);
  });

  it("U-MC4b: a matrix that excludes gloo/image removes the kind AND then the model", () => {
    // This is the pre-D1 matrix. A model left with zero serviceable kinds must disappear
    // entirely — leaving it in with `kinds: []` would put an unselectable row in the
    // picker with nothing to explain it.
    const preD1 = {
      storyboard: ["gloo", "openrouter"],
      script: ["gloo", "openrouter"],
      image: ["openrouter"],
      narration: ["openrouter"],
      music: ["openrouter"],
      video: ["openrouter"],
    } as const;

    const filtered = filterByMatrix(models, preD1);
    expect(filtered.map((m) => m.id)).toEqual(["g-txt", "or-img", "or-tts"]);
  });
});

describe("narrowToSelectableKinds (U-MC13)", () => {
  it("U-MC13a: drops entries that serve no kind the Inspector has a selector for", () => {
    // Measured on the live catalogues: 364 entries published, only 26 carrying a
    // selectable kind. The other 338 are text-only chat models that no control can ever
    // render — ~67 KB of JSON serialized by the api, shipped `cache: "no-store"` and
    // re-parsed by a browser-side Zod schema on EVERY studio open, to populate nothing.
    const kept = narrowToSelectableKinds([
      { id: "or-img", provider: "openrouter", label: "", kinds: ["image"], pricing: null },
      {
        id: "or-txt",
        provider: "openrouter",
        label: "",
        kinds: ["storyboard", "script"],
        pricing: null,
      },
      { id: "or-vid", provider: "openrouter", label: "", kinds: ["video"], pricing: null },
    ]);
    expect(kept.map((m) => m.id)).toEqual(["or-img", "or-vid"]);
  });

  it("U-MC13b: a surviving entry keeps its FULL kinds list, text kinds included", () => {
    // Trimming would be a second, unmeasured behaviour change: `kinds` is the honest
    // statement of what a model serves, and `cost-estimate.ts` reads it to decide whether
    // the selected model can serve the kind at all. The saving is in dropping ENTRIES.
    const kept = narrowToSelectableKinds([
      {
        id: "gloo-multi",
        provider: "gloo",
        label: "",
        kinds: ["image", "storyboard", "script"],
        pricing: null,
      },
    ]);
    expect(kept[0]?.kinds).toEqual(["image", "storyboard", "script"]);
  });
});
