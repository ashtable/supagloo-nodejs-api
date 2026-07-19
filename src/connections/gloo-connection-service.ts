import {
  encryptSecret,
  type GlooConnection,
  type PrismaClient,
} from "@supagloo/database-lib";
import { GlooVerificationError } from "./errors";

/**
 * Gloo connection data-access + policy (design-delta §2.5/§8). The headline
 * invariant is VERIFY-THEN-STORE: a client-credentials test mint must succeed
 * BEFORE any row is written, so a failed verify creates/updates nothing. The verify
 * itself is an injected closure (from `makeGlooClient`), keeping this class free of
 * outbound HTTP and unit-testable with a fake Prisma + fake verifier + fixed clock.
 *
 * The client secret is AES-256-GCM-encrypted at rest via database-lib's shared
 * `encryptSecret` (§2.10); `clientId` is stored plaintext (it is not a secret). The
 * minted token is discarded — only the verification timestamp is persisted.
 */
export interface GlooConnectionServiceOptions {
  prisma: PrismaClient;
  /** Client-credentials test mint — true iff the pair is valid (from `makeGlooClient`). */
  verifyClientCredentials(args: {
    clientId: string;
    clientSecret: string;
  }): Promise<boolean>;
  /** 64-hex AES-256-GCM key (env `SECRETS_ENCRYPTION_KEY`). */
  encryptionKey: string;
  /** Injectable for deterministic tests; defaults to wall-clock. */
  clock?: () => Date;
}

export class GlooConnectionService {
  private readonly prisma: PrismaClient;
  private readonly verify: GlooConnectionServiceOptions["verifyClientCredentials"];
  private readonly encryptionKey: string;
  private readonly clock: () => Date;

  constructor(opts: GlooConnectionServiceOptions) {
    this.prisma = opts.prisma;
    this.verify = opts.verifyClientCredentials;
    this.encryptionKey = opts.encryptionKey;
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * Verify the client-credentials pair by minting a test token, THEN encrypt +
   * store (design-delta §2.5). Throws {@link GlooVerificationError} (→ 400) on a
   * failed mint — and critically does NOT touch the DB in that case (no row is
   * created or updated). On success, persists `clientId` + the encrypted secret +
   * `connectedAt`/`lastVerifiedAt`.
   */
  async connect(
    userId: string,
    { clientId, clientSecret }: { clientId: string; clientSecret: string },
  ): Promise<GlooConnection> {
    const verified = await this.verify({ clientId, clientSecret });
    if (!verified) {
      throw new GlooVerificationError(
        `Gloo client credentials for client ${clientId} could not be verified`,
      );
    }

    const now = this.clock();
    const data = {
      clientId,
      clientSecretCiphertext: encryptSecret(clientSecret, this.encryptionKey),
      status: "connected",
      connectedAt: now,
      lastVerifiedAt: now,
    };
    return this.prisma.glooConnection.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  /** Remove the stored connection (idempotent — `deleteMany` on a 0-count is a
   *  no-op, so a double-disconnect does not throw). */
  async disconnect(userId: string): Promise<void> {
    await this.prisma.glooConnection.deleteMany({ where: { userId } });
  }
}
