import { AI_PROVIDERS_BY_KIND } from "@supagloo/database-lib";
import {
  filterByMatrix,
  toGlooCatalogueEntry,
  toOpenRouterCatalogueEntry,
  toOpenRouterSpeechEntry,
  toOpenRouterVideoEntry,
  type AiModelInfo,
  type ProviderMatrix,
} from "./model-catalogue";

/**
 * `GET /v1/ai/models` — the live AI model catalogue for one user.
 *
 * ── Degradation is the design ───────────────────────────────────────────────────────
 * This endpoint sits directly in front of a UI control. If it throws, the Inspector has
 * no provider picker and no cost row at all; if it lies, the user picks a model that
 * cannot run and finds out minutes and dollars later. So every upstream is read
 * independently and every failure is contained to its own slice: a dead Gloo catalogue
 * costs the Gloo models, a dead video catalogue costs the video models, and a dead
 * network yields an empty list — always a 200-shaped answer.
 *
 * One distinction is deliberately preserved: `providers.gloo` reports whether the user is
 * CONNECTED, not whether the read succeeded. Collapsing the two would make the Inspector
 * tell someone who has already linked Gloo to go and link it.
 *
 * ── Why the credential loader is injected ───────────────────────────────────────────
 * Gloo's catalogue needs a bearer minted from the user's client credentials, which are
 * encrypted at rest in this service's own database. That is the entire reason this
 * endpoint lives in the api rather than the BFF. Injecting the loader keeps this class
 * unit-testable without Prisma, and keeps decryption in exactly one place.
 *
 * ── The cache ───────────────────────────────────────────────────────────────────────
 * The studio reads this on every open. A cold read is four upstream round trips (three
 * OpenRouter catalogues, plus a Gloo mint and catalogue) and the catalogues change on the
 * order of days, so a short process-level TTL is the right trade. Keyed PER USER: the
 * Gloo half is fetched with the caller's own bearer, so a shared key would serve one
 * account's provider entitlements to another.
 */

const DEFAULT_TTL_MS = 10 * 60_000;

export interface GlooCredential {
  clientId: string;
  clientSecret: string;
}

export interface ModelCatalogueResult {
  models: AiModelInfo[];
  /** Whether the user has each provider CONNECTED (not whether its catalogue read
   *  succeeded — see the class comment). */
  providers: { gloo: boolean; openrouter: boolean };
}

export interface ModelCatalogueServiceOptions {
  openrouterBaseUrl: string;
  glooBaseUrl: string;
  /** Resolve the caller's Gloo client credentials, or null when not connected. */
  loadGlooCredential: (userId: string) => Promise<GlooCredential | null>;
  fetchImpl?: typeof fetch;
  /** Defaults to the shared db-lib matrix; injectable so the filtering RULE can be
   *  tested independently of the constant's current value. */
  matrix?: ProviderMatrix;
  ttlMs?: number;
  now?: () => number;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** Read a JSON array off a catalogue endpoint, tolerating `data`/`models` envelopes.
 *  Returns `[]` for ANY failure — non-2xx, unparseable body, thrown fetch. */
async function readCatalogue(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown[]> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: unknown; models?: unknown };
    const raw = body?.data ?? body?.models;
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export class ModelCatalogueService {
  private readonly opts: ModelCatalogueServiceOptions;
  private readonly matrix: ProviderMatrix;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<
    string,
    { at: number; value: ModelCatalogueResult }
  >();

  constructor(opts: ModelCatalogueServiceOptions) {
    this.opts = opts;
    this.matrix = opts.matrix ?? (AI_PROVIDERS_BY_KIND as ProviderMatrix);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async read(userId: string): Promise<ModelCatalogueResult> {
    const cached = this.cache.get(userId);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.value;

    const value = await this.load(userId);
    this.cache.set(userId, { at: this.now(), value });
    return value;
  }

  private async load(userId: string): Promise<ModelCatalogueResult> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const or = trimSlash(this.opts.openrouterBaseUrl);

    const glooCredential = await this.opts
      .loadGlooCredential(userId)
      .catch(() => null);

    const [chat, speech, video, gloo] = await Promise.all([
      readCatalogue(fetchImpl, `${or}/api/v1/models`),
      readCatalogue(fetchImpl, `${or}/api/v1/models?output_modalities=speech`),
      readCatalogue(fetchImpl, `${or}/api/v1/videos/models`),
      glooCredential
        ? this.readGlooCatalogue(fetchImpl, glooCredential)
        : Promise.resolve([]),
    ]);

    const models = filterByMatrix(
      [
        ...chat.map((r) => toOpenRouterCatalogueEntry(r as never)),
        ...speech.map((r) => toOpenRouterSpeechEntry(r as never)),
        ...video.map((r) => toOpenRouterVideoEntry(r as never)),
        ...gloo.map((r) => toGlooCatalogueEntry(r as never)),
      ],
      this.matrix,
    );

    return {
      models,
      providers: { gloo: glooCredential !== null, openrouter: true },
    };
  }

  /** Mint a bearer, then read Gloo's own catalogue. Any failure yields `[]`, which the
   *  caller renders as "Gloo has no models to offer right now" rather than as an error —
   *  the OpenRouter half of the picker must stay usable. */
  private async readGlooCatalogue(
    fetchImpl: typeof fetch,
    cred: GlooCredential,
  ): Promise<unknown[]> {
    const root = trimSlash(this.opts.glooBaseUrl);
    try {
      const basic = Buffer.from(`${cred.clientId}:${cred.clientSecret}`).toString(
        "base64",
      );
      const tokenRes = await fetchImpl(`${root}/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        // `scope=api/access` is required — the mint succeeds without it but the resulting
        // token is not accepted by the platform surfaces.
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "api/access",
        }),
      });
      if (!tokenRes.ok) return [];
      const token = (await tokenRes.json()) as { access_token?: unknown };
      if (typeof token.access_token !== "string") return [];

      // NOTE the path prefix: `/platform/v2/models`, NOT `/ai/v2/models` (which is a 404
      // despite Gloo's own error text citing it) and NOT the `/ai/v2` chat surface.
      return await readCatalogue(fetchImpl, `${root}/platform/v2/models`, {
        authorization: `Bearer ${token.access_token}`,
      });
    } catch {
      return [];
    }
  }
}
