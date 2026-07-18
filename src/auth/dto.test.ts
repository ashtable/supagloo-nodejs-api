import { describe, it, expect } from "vitest";
import { AuthUserSchema, type User } from "@supagloo/database-lib";
import { toAuthUser } from "./dto";

// Unit tests for the User → AuthUser wire mapping (design-delta §2.1). The DTO
// has three jobs: copy the identity/string columns verbatim, serialize every
// Prisma `DateTime` to an ISO-8601 string, and preserve `onboardingCompletedAt`
// as `null` until onboarding is done. It is exercised indirectly by the e2e auth
// suite; these tests pin the mapping directly so a regression fails fast and in
// isolation. No DB, no network.

// Distinct, human-recognizable timestamps per field so a mis-wired mapping (e.g.
// `firstSignInAt` accidentally sourced from `createdAt`) fails rather than
// silently passing. `User` carries only its scalar columns by default.
const baseUser: User = {
  id: "u_123",
  youversionUserId: "yv-user-1001",
  displayName: "Ada Lovelace",
  email: "ada@example.test",
  avatarInitials: "AL",
  firstSignInAt: new Date("2026-01-02T03:04:05.000Z"),
  onboardingCompletedAt: null,
  lastSeenAt: new Date("2026-02-03T04:05:06.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-03-04T05:06:07.000Z"),
};

describe("toAuthUser — User → AuthUser wire DTO (§2.1)", () => {
  it("copies the identity/string columns verbatim", () => {
    const dto = toAuthUser(baseUser);
    expect(dto.id).toBe("u_123");
    expect(dto.youversionUserId).toBe("yv-user-1001");
    expect(dto.displayName).toBe("Ada Lovelace");
    expect(dto.email).toBe("ada@example.test");
    expect(dto.avatarInitials).toBe("AL");
  });

  it("serializes every DateTime column to its exact ISO-8601 string", () => {
    const dto = toAuthUser(baseUser);
    // Literal expected strings (not `user.x.toISOString()`) so a field swap or a
    // dropped `.toISOString()` is caught, not merely restated.
    expect(dto.firstSignInAt).toBe("2026-01-02T03:04:05.000Z");
    expect(dto.lastSeenAt).toBe("2026-02-03T04:05:06.000Z");
    expect(dto.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.updatedAt).toBe("2026-03-04T05:06:07.000Z");
    // Guard against a raw Date leaking through unconverted.
    for (const field of [
      "firstSignInAt",
      "lastSeenAt",
      "createdAt",
      "updatedAt",
    ] as const) {
      expect(typeof dto[field]).toBe("string");
    }
  });

  it("maps onboardingCompletedAt to null when the user has not onboarded", () => {
    const dto = toAuthUser({ ...baseUser, onboardingCompletedAt: null });
    expect(dto.onboardingCompletedAt).toBeNull();
  });

  it("maps onboardingCompletedAt to its ISO-8601 string once onboarding is done", () => {
    const dto = toAuthUser({
      ...baseUser,
      onboardingCompletedAt: new Date("2026-04-05T06:07:08.000Z"),
    });
    expect(dto.onboardingCompletedAt).toBe("2026-04-05T06:07:08.000Z");
  });

  it("produces an object that satisfies the AuthUser wire schema", () => {
    // Strong end-to-end guard: if any column were left as a Date instead of a
    // string, or a field were dropped, `AuthUserSchema.parse` would throw.
    const onboarded = toAuthUser({
      ...baseUser,
      onboardingCompletedAt: new Date("2026-04-05T06:07:08.000Z"),
    });
    expect(() => AuthUserSchema.parse(onboarded)).not.toThrow();
    // The not-yet-onboarded variant (null) is equally valid on the wire.
    expect(() => AuthUserSchema.parse(toAuthUser(baseUser))).not.toThrow();
  });
});
