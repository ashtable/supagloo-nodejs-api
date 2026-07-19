import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  SESSION_TTL_MS,
  generateSessionToken,
  hashToken,
  slidingExpiry,
  isExpired,
} from "./tokens";

// Pure token + sliding-expiry logic (design-delta §2.2). No DB, no network.
// These are the primitives the AuthService and bearer plugin build on: the raw
// opaque token is returned to the client, only its SHA-256 hash is persisted.
describe("session tokens", () => {
  it("generates a high-entropy, URL/header-safe opaque token", () => {
    const token = generateSessionToken();
    // base64url: no +, /, = or whitespace — safe to send in an Authorization header.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // >=32 bytes of entropy ⇒ >=43 base64url chars.
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("generates a distinct token each call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateSessionToken());
    expect(seen.size).toBe(1000);
  });

  it("hashes a token to a stable SHA-256 hex digest (never the raw token)", () => {
    const token = "opaque-session-token";
    const expected = createHash("sha256").update(token).digest("hex");
    expect(hashToken(token)).toBe(expected);
    expect(hashToken(token)).toHaveLength(64);
    // The stored hash must not leak the raw token.
    expect(hashToken(token)).not.toContain(token);
  });

  it("produces the same hash for equal input and different hashes for different input", () => {
    expect(hashToken("a")).toBe(hashToken("a"));
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });

  it("slidingExpiry returns now + ttl", () => {
    const now = new Date("2026-07-18T00:00:00.000Z");
    expect(slidingExpiry(now, SESSION_TTL_MS).getTime()).toBe(
      now.getTime() + SESSION_TTL_MS,
    );
  });

  it("isExpired is true iff expiresAt is at or before now", () => {
    const now = new Date("2026-07-18T00:00:00.000Z");
    const past = new Date(now.getTime() - 1);
    const future = new Date(now.getTime() + 1);
    expect(isExpired(past, now)).toBe(true);
    expect(isExpired(now, now)).toBe(true);
    expect(isExpired(future, now)).toBe(false);
  });

  it("SESSION_TTL_MS is a positive sliding window", () => {
    expect(SESSION_TTL_MS).toBeGreaterThan(0);
  });
});
