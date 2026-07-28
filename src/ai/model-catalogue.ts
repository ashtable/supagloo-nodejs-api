import type { AiGenerationKind, AiProvider } from "@supagloo/database-lib";

/**
 * The PURE half of the AI model catalogue (genesis-1 Inspector, items 1 and 3).
 *
 * `lib/api/ai-config.ts` in the nextjs repo records, in its own header, that hardcoding
 * default model ids is a stopgap and that "a real discovery endpoint is the correct
 * long-term fix (tracked as a follow-up)". This module is the normalization layer of that
 * follow-up: it turns two providers' unrelated catalogue shapes into one list the studio
 * can render a picker and a cost estimate from.
 *
 * ── Why the api and not the BFF ─────────────────────────────────────────────────────
 * OpenRouter's catalogue is public, so a BFF route could read it — the shipped YouVersion
 * Bible surface is exactly that precedent. Gloo's is not: `/platform/v2/models` needs a
 * bearer minted from the user's `clientId`/`clientSecret`, which are **encrypted at rest
 * in this service's database**. The BFF cannot decrypt them. That single fact decides the
 * placement.
 *
 * ── The catalogue facts, all measured live on 2026-07-28 ────────────────────────────
 *
 * **OpenRouter** publishes four separate catalogues, and they price differently:
 *   - `GET /api/v1/models` — chat + image. `pricing.prompt`/`.completion` are $/TOKEN;
 *     `pricing.image` is $/IMAGE.
 *   - `GET /api/v1/models?output_modalities=speech` — the DEDICATED batch-TTS catalogue
 *     the speech endpoint serves. 15 entries. Prices on `prompt` with `completion: "0"`.
 *   - `GET /api/v1/models?output_modalities=audio` — a DIFFERENT catalogue, 4 entries,
 *     and the only one carrying the music models. **It shares no id with `…=speech`.**
 *     These answer chat/completions, which is what `requestMusic` calls.
 *   - `GET /api/v1/videos/models` — `supported_durations` + a text-to-video vs
 *     image-to-video distinction, and **no price field at all**.
 *
 * The speech/audio split is not a nicety. `generateAudio` is one workflow dispatching by
 * the row's kind to two DIFFERENT endpoints, so a model from the wrong catalogue is a 400
 * the user only discovers after choosing it.
 *
 * **Gloo** publishes one catalogue at `GET /platform/v2/models`, 106 entries, every one
 * carrying `output_modalities` and a `pricing` block of decimal STRINGS per 1k tokens.
 * (`dbos/src/testing/e2e-models.ts` claimed "no reliable per-model pricing" — that is
 * false, and this module is where the correction is put to work.)
 *
 * Three rules below carry real user-visible risk:
 *
 *  1. **A negative OpenRouter price means variable/auto-priced.** Passing it through would
 *     put a negative dollar amount in front of the user; it is dropped instead.
 *  2. **A zero `pricing.image` is not free, it is broken.** Zero-priced "free" image
 *     models return 500 on real OpenRouter, so a positive `pricing.image` is the
 *     reliability signal. Advertising "$0.00" would recommend a model that cannot run.
 *  3. **Units must be reconciled.** Gloo per-1k vs OpenRouter per-token is a silent 1000x
 *     error if it is not normalized here, in one place.
 */

export interface AiModelPricing {
  /** $ per generated image. OpenRouter only — Gloo does not price images per unit. */
  perImage?: number;
  /** $ per INPUT token (both providers, normalized). */
  perInputToken?: number;
  /** $ per OUTPUT token (both providers, normalized). */
  perOutputToken?: number;
}

export interface AiModelInfo {
  id: string;
  provider: AiProvider;
  /** Human label for the picker; falls back to the id when none is published. */
  label: string;
  /** Which generation kinds this model can actually serve. */
  kinds: AiGenerationKind[];
  /** `null` when the provider publishes nothing usable — deliberately distinct from an
   *  empty object, so a consumer cannot mistake "unpriced" for "priced at zero". */
  pricing: AiModelPricing | null;
}

/** The two text kinds, which any chat-capable model serves. */
const TEXT_KINDS: AiGenerationKind[] = ["storyboard", "script"];

/** Parse a published price into a number we are willing to show.
 *  Rejects non-finite, negative (variable/auto-priced) and — where `positiveOnly` — zero. */
function price(raw: unknown, positiveOnly = false): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return undefined;
  if (positiveOnly && n === 0) return undefined;
  return n;
}

/** Collapse an all-undefined pricing object to `null`. */
function pricingOrNull(p: AiModelPricing): AiModelPricing | null {
  return Object.values(p).some((v) => v !== undefined) ? p : null;
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

export interface RawOpenRouterModel {
  id?: unknown;
  name?: unknown;
  architecture?: { output_modalities?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown; image?: unknown };
}

/** Modalities → the kinds the studio can request. An unplaceable model yields NO kinds
 *  rather than a guess: putting it in a picker would produce a provider 400 later. */
export function kindsForOpenRouterModel(modalities: string[]): AiGenerationKind[] {
  const kinds: AiGenerationKind[] = [];
  if (modalities.includes("image")) kinds.push("image");
  if (modalities.includes("text")) kinds.push(...TEXT_KINDS);
  return kinds;
}

export function toOpenRouterCatalogueEntry(raw: RawOpenRouterModel): AiModelInfo {
  const id = typeof raw.id === "string" ? raw.id : "";
  const pricing: AiModelPricing = {};
  // `image` is positive-only (rule 2); the token rates may legitimately be zero on a
  // genuinely free CHAT model, which does work.
  const perImage = price(raw.pricing?.image, true);
  const perInputToken = price(raw.pricing?.prompt);
  const perOutputToken = price(raw.pricing?.completion);
  if (perImage !== undefined) pricing.perImage = perImage;
  if (perInputToken !== undefined) pricing.perInputToken = perInputToken;
  if (perOutputToken !== undefined) pricing.perOutputToken = perOutputToken;

  return {
    id,
    provider: "openrouter",
    label: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id,
    kinds: kindsForOpenRouterModel(strings(raw.architecture?.output_modalities)),
    pricing: pricingOrNull(pricing),
  };
}

export interface RawOpenRouterSpeechModel {
  id?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; audio?: unknown };
}

/**
 * Pricing for either audio catalogue. Three fields must be consulted: batch-TTS models
 * price on `prompt` with `completion: "0"`, while chat-audio models price on
 * `audio`/`completion`.
 *
 * `positiveOnly` throughout, and that is load-bearing rather than tidy: both Lyria music
 * models publish `{prompt: "0", completion: "0"}` live. Passing a zero through would put
 * `$0.0000` in front of a user about to spend money — the same lie rule 2 refuses for
 * "free" image models. An absent price makes the cost row say "This model publishes no
 * pricing", which is the true statement.
 */
function audioPricing(raw: RawOpenRouterSpeechModel): AiModelPricing | null {
  const pricing: AiModelPricing = {};
  const perInputToken = price(raw.pricing?.prompt, true) ?? price(raw.pricing?.audio, true);
  const perOutputToken = price(raw.pricing?.completion, true);
  if (perInputToken !== undefined) pricing.perInputToken = perInputToken;
  if (perOutputToken !== undefined) pricing.perOutputToken = perOutputToken;
  return pricingOrNull(pricing);
}

/**
 * `GET /api/v1/models?output_modalities=speech` — the dedicated batch-TTS catalogue,
 * 15 entries live on 2026-07-28. **Narration ONLY.**
 *
 * This used to be stamped `["narration","music"]` on the claim that `generateAudio` calls
 * the speech endpoint for both kinds. That claim is false. `generate-audio.ts` dispatches
 * by the row's kind: narration goes to `requestSpeech` → `POST /api/v1/audio/speech`,
 * music goes to `requestMusic` → the streaming `POST /api/v1/chat/completions`. The music
 * models live in a DIFFERENT catalogue ({@link toOpenRouterAudioEntry}) that shares no id
 * with this one — so offering a speech id in the music picker handed the chat endpoint a
 * model it does not serve.
 */
export function toOpenRouterSpeechEntry(raw: RawOpenRouterSpeechModel): AiModelInfo {
  const id = typeof raw.id === "string" ? raw.id : "";
  return {
    id,
    provider: "openrouter",
    label: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id,
    kinds: ["narration"],
    pricing: audioPricing(raw),
  };
}

/**
 * `GET /api/v1/models?output_modalities=audio` — a SEPARATE catalogue from `…=speech`,
 * and the one that actually carries the music models. Verified live 2026-07-28: 4 entries
 * (both Lyria models plus two chat-audio models), zero overlap with the 15 speech
 * entries. All four answer `POST /api/v1/chat/completions`, which is exactly what
 * `requestMusic` calls.
 */
export function toOpenRouterAudioEntry(raw: RawOpenRouterSpeechModel): AiModelInfo {
  const id = typeof raw.id === "string" ? raw.id : "";
  return {
    id,
    provider: "openrouter",
    label: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id,
    kinds: ["music"],
    pricing: audioPricing(raw),
  };
}

export interface RawOpenRouterVideoModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  supported_durations?: unknown;
}

/**
 * The video catalogue. **`pricing` is unconditionally `null`** — not because we failed to
 * parse it, but because `/api/v1/videos/models` publishes no price field of any kind.
 * That is the fact behind item 3's honest degradation: a video cost estimate cannot be
 * computed, so it must say so rather than invent a number.
 */
export function toOpenRouterVideoEntry(raw: RawOpenRouterVideoModel): AiModelInfo {
  const id = typeof raw.id === "string" ? raw.id : "";
  return {
    id,
    provider: "openrouter",
    label: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id,
    kinds: ["video"],
    pricing: null,
  };
}

// ---------------------------------------------------------------------------
// Gloo
// ---------------------------------------------------------------------------

export interface RawGlooModel {
  id?: unknown;
  name?: unknown;
  output_modalities?: unknown;
  pricing?: {
    input?: { rate_per_1k_tokens?: unknown };
    output?: { rate_per_1k_tokens?: unknown };
  };
}

/**
 * Gloo modalities → kinds. Structurally cannot produce `narration`/`music`/`video`, and
 * that is deliberate rather than defensive: Gloo has zero catalogue entries matching
 * audio/speech/tts/voice/narration/music/video, and those API routes answer **404**
 * (route absent) rather than 405 (route exists, wrong method). Gloo's backend is FastAPI,
 * so that distinction makes the negative trustworthy. Even if the catalogue one day
 * publishes an `audio` modality, offering it here would produce a picker option no
 * workflow can serve — the modality has to be wired end to end first.
 */
export function kindsForGlooModel(modalities: string[]): AiGenerationKind[] {
  const kinds: AiGenerationKind[] = [];
  if (modalities.includes("image")) kinds.push("image");
  if (modalities.includes("text")) kinds.push(...TEXT_KINDS);
  return kinds;
}

export function toGlooCatalogueEntry(raw: RawGlooModel): AiModelInfo {
  const id = typeof raw.id === "string" ? raw.id : "";
  const pricing: AiModelPricing = {};
  // Published per 1k tokens as a decimal STRING; normalized to per token so a Gloo price
  // and an OpenRouter price are the same unit.
  const input = price(raw.pricing?.input?.rate_per_1k_tokens, true);
  const output = price(raw.pricing?.output?.rate_per_1k_tokens, true);
  if (input !== undefined) pricing.perInputToken = input / 1000;
  if (output !== undefined) pricing.perOutputToken = output / 1000;

  return {
    id,
    provider: "gloo",
    label: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id,
    kinds: kindsForGlooModel(strings(raw.output_modalities)),
    pricing: pricingOrNull(pricing),
  };
}

// ---------------------------------------------------------------------------
// The matrix gate
// ---------------------------------------------------------------------------

export type ProviderMatrix = Readonly<
  Record<AiGenerationKind, readonly AiProvider[]>
>;

/**
 * Drop every (model, kind) pair the compatibility matrix forbids, then drop any model
 * left with no serviceable kind.
 *
 * The second half matters: leaving a model in with `kinds: []` would put an unselectable
 * row in the picker with nothing on screen to explain it. The Inspector's
 * present-but-disabled treatment is for PROVIDERS (with a plain reason like "no speech
 * models"), not for individual models.
 *
 * The matrix is a parameter rather than a direct import so the RULE is testable
 * independently of whichever value the shared constant currently holds.
 */
export function filterByMatrix(
  models: AiModelInfo[],
  matrix: ProviderMatrix,
): AiModelInfo[] {
  return models
    .map((m) => ({
      ...m,
      kinds: m.kinds.filter((k) => (matrix[k] ?? []).includes(m.provider)),
    }))
    .filter((m) => m.id.length > 0 && m.kinds.length > 0);
}

/**
 * The kinds the Inspector actually has a selector for. The two TEXT kinds are absent on
 * purpose — `storyboard`/`script` are chosen by the system, not the user, so a model that
 * serves only those can never appear in any control.
 *
 * Mirrors `nextjs/app/api/ai/models/route.ts`'s `SELECTABLE_KINDS` and
 * `nextjs/lib/studio/ai-settings.ts`. Three copies of a four-element list is cheaper than
 * a wire contract for it, but they must move together.
 */
const SELECTABLE_KINDS: readonly AiGenerationKind[] = [
  "image",
  "narration",
  "music",
  "video",
];

/**
 * Drop every model that serves no selectable kind.
 *
 * Measured against the live catalogues on 2026-07-28: **364 entries published, 26 of them
 * carrying a selectable kind.** The other 338 are text-only chat models. The upstream
 * fetches are TTL-cached, but the serialization and the browser-side Zod parse are not
 * (the studio reads this `cache: "no-store"` on every open), so those entries cost
 * ~67 KB → ~4.7 KB of parse work per studio open for a list nothing can render.
 *
 * Two deliberate restraints:
 *
 *  - **A surviving entry keeps its full `kinds` list.** The saving is in dropping ENTRIES.
 *    Trimming `["image","storyboard","script"]` down to `["image"]` would make `kinds`
 *    stop being an honest statement of what the model serves, for no measured gain.
 *  - **This is a CONSTANT, never a `?kinds=` query parameter.** `ModelCatalogueService`'s
 *    cache is keyed on `userId` alone; a caller-varying narrowing would let one request's
 *    narrower answer be served to the next caller who asked for more.
 */
export function narrowToSelectableKinds(models: AiModelInfo[]): AiModelInfo[] {
  return models.filter((m) => m.kinds.some((k) => SELECTABLE_KINDS.includes(k)));
}
