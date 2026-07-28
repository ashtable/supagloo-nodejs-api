import { z } from "zod";
import { AiGenerationKindSchema, AiProviderSchema } from "@supagloo/database-lib";

/**
 * The wire contract for `GET /v1/ai/models` (genesis-1 Inspector, items 1 and 3).
 *
 * ── Why this lives in the api repo rather than db-lib ───────────────────────────────
 * db-lib is the shared-constant home for things BOTH the api and the DBOS worker need
 * (workflow names, the compatibility matrix, the manifest format). This DTO is needed by
 * the api and by the browser — and the nextjs repo deliberately does NOT import db-lib
 * (it hand-mirrors every wire type in `lib/api/contracts.ts`, a decision taken when the
 * db-lib pin lagged the auth DTOs). Putting it in db-lib would buy nothing today and
 * would put a UI feature behind the db-lib release chain. It moves there the day the
 * worker needs it.
 *
 * `pricing` is `.nullable()` rather than `.optional()` on purpose: `null` means the
 * provider publishes nothing usable, and that has to stay distinguishable from "priced at
 * zero". The consumer renders the two completely differently — one says "not published",
 * the other would say "free".
 */

export const AiModelPricingSchema = z.object({
  /** $ per generated image (OpenRouter's per-image price). */
  perImage: z.number().optional(),
  /** $ per input token, normalized across providers (Gloo publishes per 1k). */
  perInputToken: z.number().optional(),
  /** $ per output token, normalized across providers. */
  perOutputToken: z.number().optional(),
});
export type AiModelPricingDto = z.infer<typeof AiModelPricingSchema>;

export const AiModelInfoSchema = z.object({
  id: z.string().min(1),
  provider: AiProviderSchema,
  label: z.string().min(1),
  /** The generation kinds this model can actually serve, already intersected with the
   *  compatibility matrix — so a kind listed here is one the request will be allowed to
   *  create AND a workflow can execute. */
  kinds: z.array(AiGenerationKindSchema),
  pricing: AiModelPricingSchema.nullable(),
});
export type AiModelInfoDto = z.infer<typeof AiModelInfoSchema>;

export const AiModelCatalogueResponseSchema = z.object({
  /** Narrowed to models serving at least one SELECTABLE kind (image/narration/music/
   *  video): the text kinds have no Inspector control, so a text-only model can never be
   *  rendered. Live, that is 26 of 364 entries. The narrowing is a CONSTANT rather than a
   *  `?kinds=` parameter — the service's cache is keyed on `userId` alone, so a
   *  caller-varying narrowing would serve one request's narrower answer to the next. */
  models: z.array(AiModelInfoSchema),
  /** Whether the caller has each provider CONNECTED. Deliberately NOT "whether its
   *  catalogue read succeeded": telling a user who has already linked Gloo to go and link
   *  it is a worse failure than showing them an empty Gloo list. */
  providers: z.object({ gloo: z.boolean(), openrouter: z.boolean() }),
});
export type AiModelCatalogueResponse = z.infer<
  typeof AiModelCatalogueResponseSchema
>;
