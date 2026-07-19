import {
  encryptSecret,
  decryptSecret,
  type OpenRouterConnection,
  type PrismaClient,
} from "@supagloo/database-lib";
import type { OpenRouterCredits } from "./openrouter-client";
import { OpenRouterNotConnectedError } from "./errors";

/**
 * OpenRouter connection data-access + policy (design-delta §2.5/§8). Kept behind one
 * class so routes stay thin and every branch is unit-testable with a fake Prisma +
 * fake credits closure + fixed clock (mirrors `GithubConnectionService`).
 *
 * The API key is AES-256-GCM-encrypted at rest via database-lib's shared
 * `encryptSecret` (§2.10); only a display-safe `keyLast4` is stored plaintext. There
 * is NO server-side callback (the browser did PKCE) — `connect` simply encrypts and
 * upserts. The live credit balance is proxied on demand and never stored.
 */
export interface OpenRouterConnectionServiceOptions {
  prisma: PrismaClient;
  /** Live-credits proxy — called with the DECRYPTED key (from `makeOpenRouterClient`). */
  getCredits(apiKey: string): Promise<OpenRouterCredits>;
  /** 64-hex AES-256-GCM key (env `SECRETS_ENCRYPTION_KEY`). */
  encryptionKey: string;
  /** Injectable for deterministic tests; defaults to wall-clock. */
  clock?: () => Date;
}

export interface OpenRouterCreditsView {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

export class OpenRouterConnectionService {
  private readonly prisma: PrismaClient;
  private readonly getCreditsFor: OpenRouterConnectionServiceOptions["getCredits"];
  private readonly encryptionKey: string;
  private readonly clock: () => Date;

  constructor(opts: OpenRouterConnectionServiceOptions) {
    this.prisma = opts.prisma;
    this.getCreditsFor = opts.getCredits;
    this.encryptionKey = opts.encryptionKey;
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * Store the user's OpenRouter key: derive `keyLast4` from the RAW key (before
   * encryption, for masked display), encrypt the key, and upsert. No verify step —
   * the key was obtained by the browser via PKCE.
   */
  async connect(userId: string, key: string): Promise<OpenRouterConnection> {
    const now = this.clock();
    const data = {
      apiKeyCiphertext: encryptSecret(key, this.encryptionKey),
      keyLast4: key.slice(-4),
      status: "connected",
      connectedAt: now,
    };
    return this.prisma.openRouterConnection.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  /**
   * Live credit balance for `userId` (design-delta §8): decrypt the stored key,
   * proxy OpenRouter, and reshape with `remaining = totalCredits − totalUsage`.
   * Never stored. Throws {@link OpenRouterNotConnectedError} (→ 409) when the user
   * has no connection.
   */
  async getCredits(userId: string): Promise<OpenRouterCreditsView> {
    const connection = await this.prisma.openRouterConnection.findUnique({
      where: { userId },
    });
    if (!connection) throw new OpenRouterNotConnectedError();

    const key = decryptSecret(connection.apiKeyCiphertext, this.encryptionKey);
    const { totalCredits, totalUsage } = await this.getCreditsFor(key);
    return { totalCredits, totalUsage, remaining: totalCredits - totalUsage };
  }

  /** Remove the stored connection (idempotent — `deleteMany` on a 0-count is a
   *  no-op, so a double-disconnect does not throw). */
  async disconnect(userId: string): Promise<void> {
    await this.prisma.openRouterConnection.deleteMany({ where: { userId } });
  }
}
