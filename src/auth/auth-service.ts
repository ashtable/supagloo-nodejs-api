import type {
  PrismaClient,
  Session,
  TestSeedRequest,
  User,
} from "@supagloo/database-lib";
import { UnauthorizedError } from "./errors";
import {
  SESSION_TTL_MS,
  generateSessionToken,
  hashToken,
  isExpired,
  slidingExpiry,
} from "./tokens";
import type { YouVersionVerifier } from "./youversion";

/**
 * All auth/session data-access + policy (design-delta §2.1/§2.2/§6a/§9-Q6). Kept
 * behind one class so the routes and the bearer plugin stay thin, and so unit
 * tests can drive every branch with a fake Prisma + fixed clock + fake verifier.
 */
export interface AuthServiceOptions {
  prisma: PrismaClient;
  verifyToken: YouVersionVerifier;
  /** Injectable for deterministic expiry tests; defaults to wall-clock. */
  clock?: () => Date;
  /** Sliding window length; defaults to {@link SESSION_TTL_MS}. */
  sessionTtlMs?: number;
}

export interface SignInResult {
  token: string;
  user: User;
  firstSignIn: boolean;
}

export interface AuthenticateResult {
  user: User;
  session: Session;
}

export interface SeedResult {
  users: Array<{ user: User; token: string }>;
}

export class AuthService {
  private readonly prisma: PrismaClient;
  private readonly verifyToken: YouVersionVerifier;
  private readonly clock: () => Date;
  private readonly ttl: number;

  constructor(opts: AuthServiceOptions) {
    this.prisma = opts.prisma;
    this.verifyToken = opts.verifyToken;
    this.clock = opts.clock ?? (() => new Date());
    this.ttl = opts.sessionTtlMs ?? SESSION_TTL_MS;
  }

  /**
   * Verify a YouVersion access token, upsert the `User` (create ⇒ set
   * `firstSignInAt`), mint an opaque session, and persist only its hash. Returns
   * the raw token, the user, and `firstSignIn` (true iff the row was created).
   * Throws {@link UnauthorizedError} when the access token is invalid.
   */
  async signIn(accessToken: string): Promise<SignInResult> {
    const info = await this.verifyToken(accessToken);
    if (!info) throw new UnauthorizedError("invalid YouVersion access token");

    const now = this.clock();
    const updateData = {
      displayName: info.displayName,
      email: info.email,
      avatarInitials: info.avatarInitials,
      lastSeenAt: now,
    };

    // findUnique-then-branch: Prisma `upsert` cannot report created-vs-updated,
    // which is exactly what `firstSignIn` needs. The create is wrapped so a rare
    // concurrent first-sign-in race (both branches see no row) degrades to an
    // update instead of a 500.
    const existing = await this.prisma.user.findUnique({
      where: { youversionUserId: info.youversionUserId },
    });

    let user: User;
    let firstSignIn: boolean;
    if (existing) {
      user = await this.prisma.user.update({
        where: { youversionUserId: info.youversionUserId },
        data: updateData,
      });
      firstSignIn = false;
    } else {
      try {
        user = await this.prisma.user.create({
          data: {
            youversionUserId: info.youversionUserId,
            displayName: info.displayName,
            email: info.email,
            avatarInitials: info.avatarInitials,
            firstSignInAt: now,
            lastSeenAt: now,
          },
        });
        firstSignIn = true;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        user = await this.prisma.user.update({
          where: { youversionUserId: info.youversionUserId },
          data: updateData,
        });
        firstSignIn = false;
      }
    }

    const token = generateSessionToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: slidingExpiry(now, this.ttl),
        lastUsedAt: now,
      },
    });

    return { token, user, firstSignIn };
  }

  /**
   * Resolve a bearer token to its user with sliding expiry. Returns `null` for a
   * missing/garbage/expired token; on success bumps `lastUsedAt`/`expiresAt`.
   */
  async authenticate(rawToken: string): Promise<AuthenticateResult | null> {
    const now = this.clock();
    const row = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { user: true },
    });
    if (!row) return null;
    if (isExpired(row.expiresAt, now)) return null;

    const session = await this.prisma.session.update({
      where: { id: row.id },
      data: { lastUsedAt: now, expiresAt: slidingExpiry(now, this.ttl) },
    });
    return { user: row.user, session };
  }

  /** DB-backed revocation (§9-Q6): delete the session row synchronously. */
  async signOut(sessionId: string): Promise<void> {
    await this.prisma.session.delete({ where: { id: sessionId } });
  }

  /** Stamp `onboardingCompletedAt` on the user (design-delta §2.1). */
  async completeOnboarding(userId: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { onboardingCompletedAt: this.clock() },
    });
  }

  /**
   * Idempotently seed deterministic users + sessions (§9-Q9). Keyed by
   * `youversionUserId` (user) and the raw `sessionToken`'s hash (session), so
   * re-seeding the same spec is a no-op and the caller-supplied token
   * bearer-authenticates immediately.
   */
  async seed(req: TestSeedRequest): Promise<SeedResult> {
    const now = this.clock();
    const users: SeedResult["users"] = [];

    for (const u of req.users) {
      const user = await this.prisma.user.upsert({
        where: { youversionUserId: u.youversionUserId },
        create: {
          youversionUserId: u.youversionUserId,
          displayName: u.displayName,
          email: u.email,
          avatarInitials: u.avatarInitials,
          firstSignInAt: now,
          lastSeenAt: now,
          onboardingCompletedAt: u.onboardingCompleted ? now : null,
        },
        update: {
          displayName: u.displayName,
          email: u.email,
          avatarInitials: u.avatarInitials,
          lastSeenAt: now,
          ...(u.onboardingCompleted ? { onboardingCompletedAt: now } : {}),
        },
      });

      await this.prisma.session.upsert({
        where: { tokenHash: hashToken(u.sessionToken) },
        create: {
          userId: user.id,
          tokenHash: hashToken(u.sessionToken),
          expiresAt: slidingExpiry(now, this.ttl),
          lastUsedAt: now,
        },
        update: {
          expiresAt: slidingExpiry(now, this.ttl),
          lastUsedAt: now,
        },
      });

      users.push({ user, token: u.sessionToken });
    }

    return { users };
  }
}

/** Duck-typed Prisma unique-constraint violation (P2002) — avoids importing the
 *  Prisma error class, which the query-compiler client shapes differently. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}
