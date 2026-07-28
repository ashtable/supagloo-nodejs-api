import { describe, expect, it, beforeAll } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from "jose";
import {
  makeYouVersionVerifier,
  youVersionEndpointsFrom,
  youVersionUserFields,
} from "./youversion";

/**
 * These drive the REAL jose verification path. Only key RETRIEVAL is local — the
 * signature check, `alg` pinning, `iss` matching and `exp` handling all execute for
 * real, because those are our settings and are exactly what a stubbed verifier would
 * stop proving.
 *
 * Replaces the previous suite, which characterized a `GET /auth/v1/userinfo` contract
 * that was invented and does not exist (404 live). Those tests passed against a fiction:
 * every one of them stayed green while production 500'd on every sign-in.
 */

const ISSUER = "https://api.youversion.com/auth/token";

let privateKey: KeyLike;
let publicJwk: JWK;
/** A second, unrelated keypair — used to forge a correctly-shaped but wrongly-signed token. */
let attackerKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  attackerKey = (await generateKeyPair("RS256")).privateKey;
});

/** A verifier wired to the local key set, otherwise configured exactly as production. */
function verifier(overrides: { clockToleranceSec?: number } = {}) {
  return makeYouVersionVerifier({
    ...youVersionEndpointsFrom("https://api.youversion.com"),
    keySet: createLocalJWKSet({ keys: [publicJwk] }),
    ...overrides,
  });
}

interface TokenOptions {
  sub?: string;
  issuer?: string;
  expiresIn?: string;
  issuedAt?: number;
  key?: KeyLike;
}

async function token(opts: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ scope: "email profile openid" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt(opts.issuedAt)
    .setExpirationTime(opts.expiresIn ?? "1h");
  if (opts.sub !== undefined) jwt.setSubject(opts.sub);
  return jwt.sign(opts.key ?? privateKey);
}

describe("makeYouVersionVerifier — accepts a genuine token", () => {
  it("returns the subject from a correctly signed token", async () => {
    const sub = "a8feb12c-3873-4a9a-8b08-d9f765b7ca1e";
    await expect(verifier()(await token({ sub }))).resolves.toEqual({
      youversionUserId: sub,
    });
  });

  /** The shape a real YouVersion access token has — no profile claims anywhere. */
  it("does not require any profile claim to be present", async () => {
    const jwt = await new SignJWT({
      scope: "email profile openid",
      client_id: "ByJ9zK1Np6T66nTKGxTmbR28djFPAZ234IEfeCNznKiQ0VTN",
      jti: "ef3953e4-85a4-48c2-9cd4-1b8d7e045c37",
    })
      .setProtectedHeader({ alg: "RS256", typ: "at+JWT" })
      .setIssuer(ISSUER)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(verifier()(jwt)).resolves.toEqual({
      youversionUserId: "user-1",
    });
  });
});

describe("makeYouVersionVerifier — rejects with null (⇒ 401)", () => {
  /** The attack this exists to stop: a well-formed token signed by someone else. */
  it("rejects a token signed by a DIFFERENT key", async () => {
    const forged = await token({ sub: "user-1", key: attackerKey });
    await expect(verifier()(forged)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const stale = await token({
      sub: "user-1",
      issuedAt: Math.floor(Date.now() / 1000) - 7200,
      expiresIn: "-1h",
    });
    await expect(verifier()(stale)).resolves.toBeNull();
  });

  it("rejects a token from the wrong issuer", async () => {
    const wrong = await token({ sub: "user-1", issuer: "https://evil.example" });
    await expect(verifier()(wrong)).resolves.toBeNull();
  });

  /**
   * `sub` is the User table's `@unique` key. A signature-valid token without one
   * identifies nobody, and accepting it would key a row on an empty string.
   */
  it("rejects a valid signature with no sub", async () => {
    await expect(verifier()(await token({}))).resolves.toBeNull();
  });

  it("rejects a blank sub", async () => {
    await expect(verifier()(await token({ sub: "   " }))).resolves.toBeNull();
  });

  it.each(["", "   ", "not-a-jwt", "a.b", "a.b.c"])(
    "rejects the malformed token %j without throwing",
    async (bad) => {
      await expect(verifier()(bad)).resolves.toBeNull();
    },
  );

  /** `alg: none` — the canonical JWT bypass. Pinning `algorithms` is what stops it. */
  it("rejects an unsigned alg:none token", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "user-1", iss: ISSUER, exp: 4102444800 }),
    ).toString("base64url");
    await expect(verifier()(`${header}.${body}.`)).resolves.toBeNull();
  });
});

describe("makeYouVersionVerifier — clock tolerance", () => {
  it("accepts a token that expired within the tolerance window", async () => {
    const justExpired = await token({
      sub: "user-1",
      issuedAt: Math.floor(Date.now() / 1000) - 60,
      expiresIn: "-10s",
    });
    await expect(
      verifier({ clockToleranceSec: 120 })(justExpired),
    ).resolves.toEqual({ youversionUserId: "user-1" });
  });

  it("still rejects one that expired well outside it", async () => {
    const longGone = await token({
      sub: "user-1",
      issuedAt: Math.floor(Date.now() / 1000) - 7200,
      expiresIn: "-1h",
    });
    await expect(
      verifier({ clockToleranceSec: 120 })(longGone),
    ).resolves.toBeNull();
  });
});

describe("makeYouVersionVerifier — outage vs rejection", () => {
  /**
   * The distinction that keeps an outage from logging everyone out: a key set that
   * cannot answer must THROW (⇒ 5xx), not return null (⇒ 401 "your token is bad").
   */
  it("propagates a key-retrieval failure instead of returning null", async () => {
    const verify = makeYouVersionVerifier({
      ...youVersionEndpointsFrom("https://api.youversion.com"),
      keySet: () => {
        throw new Error("JWKS unreachable");
      },
    });
    await expect(verify(await token({ sub: "user-1" }))).rejects.toThrow(
      /JWKS unreachable/,
    );
  });
});

describe("youVersionEndpointsFrom", () => {
  it("derives the live issuer and JWKS URL from the default base", () => {
    expect(youVersionEndpointsFrom("https://api.youversion.com")).toEqual({
      issuer: "https://api.youversion.com/auth/token",
      jwksUrl: "https://api.youversion.com/.well-known/jwks.json",
    });
  });

  it("normalizes a trailing slash", () => {
    expect(youVersionEndpointsFrom("https://api.youversion.com/").jwksUrl).toBe(
      "https://api.youversion.com/.well-known/jwks.json",
    );
  });

  /** JWKS is at the ROOT well-known path; `/auth/.well-known/jwks.json` 404s. */
  it("puts JWKS at the root well-known path, not under /auth", () => {
    const { jwksUrl } = youVersionEndpointsFrom("https://api.youversion.com");
    expect(jwksUrl).not.toContain("/auth/.well-known");
  });
});

describe("youVersionUserFields — unverified display fields", () => {
  it("uses the supplied name and email", () => {
    expect(
      youVersionUserFields({ name: "Ash Srinivas", email: "ash@example.com" }),
    ).toEqual({
      displayName: "Ash Srinivas",
      email: "ash@example.com",
      avatarInitials: "AS",
    });
  });

  it("falls back to the email as a display name when there is no name", () => {
    const fields = youVersionUserFields({ email: "ash@example.com" });
    expect(fields.displayName).toBe("ash@example.com");
    expect(fields.email).toBe("ash@example.com");
  });

  /** The columns are NOT NULL, so a sparse profile must still produce a storable row. */
  it("produces a storable row from an entirely absent profile", () => {
    expect(youVersionUserFields(undefined)).toEqual({
      displayName: "YouVersion user",
      email: "",
      avatarInitials: "YU",
    });
  });

  it("produces a storable row from an empty profile object", () => {
    expect(youVersionUserFields({})).toEqual({
      displayName: "YouVersion user",
      email: "",
      avatarInitials: "YU",
    });
  });

  it("ignores whitespace-only fields", () => {
    expect(youVersionUserFields({ name: "   ", email: "  " }).displayName).toBe(
      "YouVersion user",
    );
  });

  it("takes one initial from a single-word name", () => {
    expect(youVersionUserFields({ name: "Ash" }).avatarInitials).toBe("A");
  });

  it("takes at most two initials", () => {
    expect(
      youVersionUserFields({ name: "Ash Vijay Srinivas" }).avatarInitials,
    ).toBe("AV");
  });

  it("never returns empty initials, even for a symbol-only name", () => {
    expect(youVersionUserFields({ name: "!!!" }).avatarInitials).toBe("YV");
  });
});
