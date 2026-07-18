import { z } from "zod";

/**
 * YouVersion access-token verification (contract: scratch/auth-and-sessions.md §0
 * — invented, since design-delta §6a leaves the exact userinfo schema open). The
 * API verifies the token the BFF forwards by calling `GET /auth/v1/userinfo` with
 * it as a bearer, then maps the returned userinfo onto the `User` model.
 */

/** Normalized userinfo the AuthService upserts into `User` (§2.1). */
export interface YouVersionUserInfo {
  youversionUserId: string;
  displayName: string;
  email: string;
  avatarInitials: string;
}

export type YouVersionVerifier = (
  accessToken: string,
) => Promise<YouVersionUserInfo | null>;

export interface MakeYouVersionVerifierOptions {
  baseUrl: string;
  /** Injectable for unit tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Raw userinfo payload shape returned by the userinfo endpoint. */
const userInfoSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  first_name: z.string().optional().default(""),
  last_name: z.string().optional().default(""),
  email: z.string(),
  avatar_url: z.string().nullish(),
});

/** Two-letter avatar initials, with a robust fallback so they're never empty. */
function initialsFrom(first: string, last: string, displayName: string): string {
  const initials = [first, last]
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p[0])
    .join("");
  if (initials) return initials.toUpperCase();
  const letters = displayName.replace(/[^A-Za-z0-9]/g, "");
  return (letters.slice(0, 2) || "??").toUpperCase();
}

/**
 * Build the verifier. Calls `GET {baseUrl}/auth/v1/userinfo` with the access token
 * as a bearer: `200` → normalized userinfo, `401` → `null` (invalid / expired),
 * anything else → throws (unexpected upstream failure — surfaces as a 5xx).
 */
export function makeYouVersionVerifier(
  options: MakeYouVersionVerifierOptions,
): YouVersionVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/auth/v1/userinfo`;

  return async (accessToken) => {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) return null;
    if (!res.ok) {
      throw new Error(`YouVersion userinfo request failed: ${res.status}`);
    }
    const raw = userInfoSchema.parse(await res.json());
    const displayName =
      `${raw.first_name} ${raw.last_name}`.trim() || raw.email;
    return {
      youversionUserId: raw.id,
      displayName,
      email: raw.email,
      avatarInitials: initialsFrom(raw.first_name, raw.last_name, displayName),
    };
  };
}
