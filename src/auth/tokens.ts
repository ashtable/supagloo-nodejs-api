import { createHash, randomBytes } from "node:crypto";

/**
 * Session token + sliding-expiry primitives (design-delta §2.2). The RAW token is
 * returned to the client once; the DB persists only its SHA-256 hash, so a
 * database leak never yields usable bearer tokens.
 */

/** Sliding session window: 30 days, refreshed on each authenticated use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Mint an opaque, high-entropy bearer token (256 bits, base64url — safe to send
 *  verbatim in an `Authorization` header). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest of a raw token — the value stored in `Session.tokenHash`. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** `now + ttl` — the fresh sliding-expiry instant. */
export function slidingExpiry(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs);
}

/** A session is expired iff its expiry is at or before `now`. */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
