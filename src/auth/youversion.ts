import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { JWTPayload } from "jose";
import type { YouVersionSignInProfile } from "@supagloo/database-lib";

/**
 * YouVersion access-token verification.
 *
 * ── What this replaced, and why ─────────────────────────────────────────────────────
 *
 * The original implementation (task 10) called `GET {base}/auth/v1/userinfo` and mapped
 * the response onto `User`. That endpoint was INVENTED — design-delta §6a left the
 * userinfo schema open and it was filled in speculatively. It does not exist. Live, it
 * returns 404, which surfaced as a 500 on every single sign-in:
 * `Error: YouVersion userinfo request failed: 404`.
 *
 * Verified against the provider on 2026-07-27:
 *  - `GET https://api.youversion.com/auth/v1/userinfo` → 404.
 *  - OIDC discovery at `/.well-known/openid-configuration` publishes `issuer` and
 *    `jwks_uri` and has **no `userinfo_endpoint`** at all. There is no endpoint to call.
 *  - JWKS lives at `https://api.youversion.com/.well-known/jwks.json` (NOT under
 *    `/auth/`, which 404s) and holds one RSA key, `alg: RS256`, `use: sig`.
 *  - A real access token decodes to `{sub, scope, iss, exp, iat, jti, client_id}` and
 *    carries NO profile claims — no email, no name, no picture — even when granted
 *    `scope: "email profile openid"`.
 *
 * So identity is established the only way it can be: by verifying the access token's
 * RS256 signature against the published JWKS and reading `sub`.
 *
 * ── Why a dependency here, when db-lib hand-rolls its App JWT ────────────────────────
 *
 * `database-lib/src/github.ts` signs GitHub App JWTs on `node:crypto` and its header
 * calls that the house style. That reasoning does not carry over. SIGNING serialises
 * claims we chose and hands them to a key we own — there is no attacker input. VERIFYING
 * parses a hostile string and then makes the trust decision the whole session rests on,
 * which is where the classic JWT defects live: `alg: none`, RS256→HS256 confusion, `kid`
 * injection, reading claims before checking the signature, skipped `exp`, and mishandled
 * key rotation. `jose` closes those by construction, and `createRemoteJWKSet` additionally
 * gets JWKS caching, rotation and refresh-cooldown right (an unbounded refresh-on-unknown-
 * kid is itself a DoS lever). Pinned to 5.x deliberately: 6.x is ESM-only and this package
 * is CommonJS, where a static import of it fails to compile (TS1479).
 */

/** The only thing a verified YouVersion token actually establishes. */
export interface VerifiedYouVersionIdentity {
  /** The token's `sub` — the `@unique` key every user lookup and authorization uses. */
  youversionUserId: string;
}

export type YouVersionVerifier = (
  accessToken: string,
) => Promise<VerifiedYouVersionIdentity | null>;

/** The display fields written to `User` alongside the verified identity. */
export interface YouVersionUserFields {
  displayName: string;
  email: string;
  avatarInitials: string;
}

export interface MakeYouVersionVerifierOptions {
  /** Expected `iss`. Must equal the discovery document's `issuer`. */
  issuer: string;
  /** Absolute JWKS URL, from the discovery document's `jwks_uri`. */
  jwksUrl: string;
  /**
   * Leeway for `exp`/`nbf`, in seconds. Small and explicit: a session that outlives its
   * token by a minute is harmless, one that outlives it by an hour is not.
   */
  clockToleranceSec?: number;
  /**
   * Where the verification key comes from. Production leaves this undefined and gets
   * {@link createRemoteJWKSet} against {@link MakeYouVersionVerifierOptions.jwksUrl}.
   *
   * Tests inject a LOCAL key set. Deliberately this and not a "skip verification" hook:
   * swapping the whole verify step would mean the tests exercise a stub and prove
   * nothing about `algorithms`, `issuer` or `clockTolerance` — the three settings most
   * likely to be wrong. Replacing only key RETRIEVAL keeps every real jose check in the
   * path while keeping the suite off the network.
   */
  keySet?: Parameters<typeof jwtVerify>[1];
}

/**
 * Derive both endpoints from `YOUVERSION_BASE_URL`, so pointing the API at another host
 * moves the issuer and the key set together — the two must always agree, and deriving
 * them from one value is what makes disagreeing impossible.
 *
 * The shapes are the live discovery document's, for the default base
 * `https://api.youversion.com`:
 *   `issuer`   → `https://api.youversion.com/auth/token`
 *   `jwks_uri` → `https://api.youversion.com/.well-known/jwks.json`
 *
 * Note JWKS is at the ROOT well-known path, not under `/auth/` — `/auth/.well-known/
 * jwks.json` 404s.
 */
export function youVersionEndpointsFrom(baseUrl: string): {
  issuer: string;
  jwksUrl: string;
} {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    issuer: `${base}/auth/token`,
    jwksUrl: `${base}/.well-known/jwks.json`,
  };
}

const DEFAULT_CLOCK_TOLERANCE_SEC = 60;

/**
 * Build the verifier.
 *
 * Returns `null` for any token the provider would reject — bad signature, expired, wrong
 * issuer, malformed, or missing `sub` — because all of those mean the same thing to the
 * caller (`AuthService` turns `null` into a 401). THROWS only when verification could not
 * be completed at all, e.g. JWKS is unreachable; that is an outage on our side and must
 * surface as a 5xx rather than silently logging users out.
 */
export function makeYouVersionVerifier(
  options: MakeYouVersionVerifierOptions,
): YouVersionVerifier {
  const clockTolerance =
    options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;

  // Built ONCE per verifier, never per request: the key set IS the cache, and rebuilding
  // it per call would refetch JWKS on every sign-in.
  const keySet = options.keySet ?? createRemoteJWKSet(new URL(options.jwksUrl));

  return async (accessToken) => {
    if (!accessToken || accessToken.trim().length === 0) return null;

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(accessToken, keySet, {
        issuer: options.issuer,
        // Pinning the algorithm is what makes `alg: none`, and an HS256 token signed
        // with the PUBLIC key, non-starters rather than things we hope jose refuses.
        algorithms: ["RS256"],
        clockTolerance,
      }));
    } catch (err) {
      if (isRejection(err)) return null;
      // Could not reach a verdict (JWKS fetch failed, etc.) — an outage, not a bad token.
      throw err;
    }

    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    // A signature-valid token with no subject identifies nobody; treating it as a sign-in
    // would key a User row on an empty string.
    if (!sub) return null;

    return { youversionUserId: sub };
  };
}

/**
 * Every jose error that means "this token is not acceptable" — as opposed to "we could
 * not check". Matched on jose's stable `code` strings rather than `instanceof`, which is
 * brittle across duplicated copies of the package in a dependency tree.
 */
const REJECTION_CODES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

function isRejection(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && REJECTION_CODES.has(code)) return true;
  // Belt and braces for a jose build whose errors reach us without `code`.
  return (
    err instanceof joseErrors.JWTExpired ||
    err instanceof joseErrors.JWTClaimValidationFailed ||
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWTInvalid ||
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JOSEAlgNotAllowed
  );
}

/**
 * Map the UNVERIFIED client-supplied profile onto the non-nullable `User` display
 * columns.
 *
 * Nothing here is trusted and nothing keys off it — see the note on
 * `YouVersionSignInProfileSchema` in database-lib. It exists because the server has no
 * other source for a name or an email (the access token has neither, and there is no
 * userinfo endpoint), and because `User.displayName`/`User.email` are NOT NULL, so a
 * sparse profile still has to produce a storable row rather than fail the sign-in.
 */
export function youVersionUserFields(
  profile: YouVersionSignInProfile | undefined,
): YouVersionUserFields {
  const name = profile?.name?.trim() ?? "";
  const email = profile?.email?.trim() ?? "";
  const displayName = name || email || "YouVersion user";
  return {
    displayName,
    email,
    avatarInitials: initialsFrom(displayName),
  };
}

/**
 * Up to two initials, never empty — `avatarInitials` is NOT NULL and renders in the UI.
 * Falls back through: first letters of the first two words → first two alphanumerics of
 * the whole string → `YV`.
 */
function initialsFrom(displayName: string): string {
  const words = displayName.split(/\s+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, "")[0])
    .filter(Boolean)
    .join("");
  if (initials) return initials.toUpperCase();

  const letters = displayName.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  return (letters || "YV").toUpperCase();
}
