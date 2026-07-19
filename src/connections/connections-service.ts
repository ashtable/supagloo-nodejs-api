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
}
