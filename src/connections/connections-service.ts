import type {
  GithubConnection,
  GlooConnection,
  OpenRouterConnection,
  PrismaClient,
} from "@supagloo/database-lib";

/**
 * Merged read across the three typed connection tables (design-delta §2.5 footnote /
 * §8). The design deliberately uses three typed tables rather than one polymorphic
 * table; the UI's unified `connections` reducer is served by `GET /v1/connections`,
 * which this service backs by reading all three by `userId`.
 *
 * A pure reader — no mutation, no encryption, no outbound HTTP — so the merge logic
 * is unit-testable with a fake Prisma. Rows are mapped to wire DTOs by the route.
 */
export interface AllConnections {
  github: GithubConnection | null;
  openrouter: OpenRouterConnection | null;
  gloo: GlooConnection | null;
}

export interface ConnectionsServiceOptions {
  prisma: PrismaClient;
}

/** The three providers a user can connect. Matches the keys of {@link AllConnections}. */
export type ConnectionProvider = keyof AllConnections;

/**
 * The narrow read the AI-generation gate needs: "has this user connected `provider`?".
 *
 * Declared as an interface so `AiGenerationsService` depends on the QUESTION rather than on
 * the whole connections service — which keeps its unit tests free of a fake Prisma for a
 * table they are not about.
 */
export interface ConnectionLookup {
  isConnected(userId: string, provider: ConnectionProvider): Promise<boolean>;
}

export class ConnectionsService {
  private readonly prisma: PrismaClient;

  constructor(opts: ConnectionsServiceOptions) {
    this.prisma = opts.prisma;
  }

  /** Read the three connection rows for `userId` in parallel; `null` per provider
   *  when that table has no row. */
  async readAll(userId: string): Promise<AllConnections> {
    const [github, openrouter, gloo] = await Promise.all([
      this.prisma.githubConnection.findUnique({ where: { userId } }),
      this.prisma.openRouterConnection.findUnique({ where: { userId } }),
      this.prisma.glooConnection.findUnique({ where: { userId } }),
    ]);
    return { github, openrouter, gloo };
  }

  /**
   * Is `provider` connected for `userId`? ROW PRESENCE is the rule — the same rule
   * {@link readAll} applies, and the same one `GET /v1/connections` publishes: the `status`
   * column is written as the literal `"connected"` and never read back.
   *
   * Backs the `provider_not_connected` 409 on `POST /v1/ai/generations`, which asks about
   * exactly ONE provider on the hot path of every reroll, narration and video generation —
   * so it is one `findUnique`, not `readAll`'s three.
   *
   * That is a second implementation of one rule, which is a shape this codebase has been
   * bitten by. `connections-service.test.ts`'s `U-PNC2` is the pin: it drives both answers
   * over the same fixtures and requires them to agree, so the two cannot diverge without a
   * red test.
   */
  async isConnected(
    userId: string,
    provider: ConnectionProvider,
  ): Promise<boolean> {
    switch (provider) {
      case "github":
        return (
          (await this.prisma.githubConnection.findUnique({ where: { userId } })) !==
          null
        );
      case "openrouter":
        return (
          (await this.prisma.openRouterConnection.findUnique({
            where: { userId },
          })) !== null
        );
      case "gloo":
        return (
          (await this.prisma.glooConnection.findUnique({ where: { userId } })) !==
          null
        );
    }
  }
}
