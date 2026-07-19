import type { AuthUser, User } from "@supagloo/database-lib";

/**
 * Map a persisted `User` row to the `AuthUser` wire DTO (design-delta §2.1):
 * Prisma `DateTime` columns become ISO-8601 strings, and the nullable
 * `onboardingCompletedAt` is preserved as `null` until onboarding is done.
 */
export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    youversionUserId: user.youversionUserId,
    displayName: user.displayName,
    email: user.email,
    avatarInitials: user.avatarInitials,
    firstSignInAt: user.firstSignInAt.toISOString(),
    onboardingCompletedAt: user.onboardingCompletedAt
      ? user.onboardingCompletedAt.toISOString()
      : null,
    lastSeenAt: user.lastSeenAt.toISOString(),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
