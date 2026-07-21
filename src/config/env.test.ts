import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const VALID_DB_URL = "postgres://supagloo:supagloo@localhost:5432/supagloo";

// The GitHub App is now a required app-level secret set (Task #11): the API
// signs App JWTs (private key + app id) and builds the hosted install URL (slug).
// A valid env therefore carries all three; helper keeps the success cases honest.
const GITHUB_APP_ID = "123456";
const GITHUB_APP_PRIVATE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nMIItest\n-----END RSA PRIVATE KEY-----";
const GITHUB_APP_SLUG = "supagloo-test";

// Task #26 create-new-repo JIT hop: the GitHub App's OAuth client credentials
// (distinct from the App's private key) — used to exchange a user-authorization
// `code` for a short-lived user token. Now required; a valid env carries both.
const GITHUB_APP_CLIENT_ID = "Iv1.stubclient";
const GITHUB_APP_CLIENT_SECRET = "stubsecret";

// Task #12: the secrets encryption key is now a required app-level secret — a
// 64-char hex string (32 bytes; `openssl rand -hex 32`). A valid env carries one.
const SECRETS_ENCRYPTION_KEY = "a".repeat(64);

// Task #13: the S3 object-storage config is now required (except S3_REGION, which
// defaults). A valid env carries the internal + public endpoints, bucket, and
// access/secret keys.
const S3_ENV = {
  S3_ENDPOINT: "http://minio:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "supagloo-dev",
  S3_ACCESS_KEY: "supagloo",
  S3_SECRET_KEY: "supagloo-dev",
};

function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: VALID_DB_URL,
    // Task #18: the DBOS system DB URL is now a required app-level var (the API
    // enqueues scaffold/git-ops jobs against it). A valid env carries one.
    DBOS_DATABASE_URL: "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_SLUG,
    GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET,
    SECRETS_ENCRYPTION_KEY,
    ...S3_ENV,
    ...overrides,
  };
}

describe("loadEnv", () => {
  it("accepts a valid postgres DATABASE_URL and applies server-bind defaults", () => {
    const env = loadEnv(validEnv());
    expect(env.DATABASE_URL).toBe(VALID_DB_URL);
    expect(env.PORT).toBe(4000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.NODE_ENV).toBe("development");
  });

  it("accepts the postgresql:// scheme and coerces overrides", () => {
    const env = loadEnv(
      validEnv({
        DATABASE_URL: "postgresql://u:p@db:5432/app",
        PORT: "8080",
        HOST: "127.0.0.1",
        NODE_ENV: "production",
      }),
    );
    expect(env.DATABASE_URL).toBe("postgresql://u:p@db:5432/app");
    expect(env.PORT).toBe(8080);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.NODE_ENV).toBe("production");
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: undefined }))).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects an empty DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: "" }))).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL scheme", () => {
    expect(() =>
      loadEnv(validEnv({ DATABASE_URL: "http://example.com/db" })),
    ).toThrow(/postgres/i);
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv(validEnv({ PORT: "not-a-number" }))).toThrow();
  });

  describe("provider base URLs (Task #9 convention)", () => {
    it("defaults to the real provider URLs when unset", () => {
      const env = loadEnv(validEnv());
      expect(env.GITHUB_API_BASE_URL).toBe("https://api.github.com");
      expect(env.GITHUB_OAUTH_BASE_URL).toBe("https://github.com");
      expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai");
      expect(env.GLOO_BASE_URL).toBe("https://platform.ai.gloo.com");
      expect(env.YOUVERSION_BASE_URL).toBe("https://api.youversion.com");
    });

    it("accepts overrides that point at http:// stub servers", () => {
      const env = loadEnv(
        validEnv({
          GITHUB_API_BASE_URL: "http://github-stub:8080",
          GITHUB_OAUTH_BASE_URL: "http://github-stub:8080",
          OPENROUTER_BASE_URL: "http://openrouter-stub:8080",
          GLOO_BASE_URL: "http://gloo-stub:8080",
          YOUVERSION_BASE_URL: "http://youversion-stub:8080",
        }),
      );
      expect(env.OPENROUTER_BASE_URL).toBe("http://openrouter-stub:8080");
      expect(env.GITHUB_API_BASE_URL).toBe("http://github-stub:8080");
    });

    it("rejects a non-http(s) provider base URL", () => {
      expect(() =>
        loadEnv(validEnv({ OPENROUTER_BASE_URL: "ftp://nope" })),
      ).toThrow(/OPENROUTER_BASE_URL/);
    });
  });

  describe("GitHub App secrets (Task #11)", () => {
    it("passes the app id, private key, and slug through", () => {
      const env = loadEnv(validEnv());
      expect(env.GITHUB_APP_ID).toBe(GITHUB_APP_ID);
      expect(env.GITHUB_APP_PRIVATE_KEY).toBe(GITHUB_APP_PRIVATE_KEY);
      expect(env.GITHUB_APP_SLUG).toBe(GITHUB_APP_SLUG);
    });

    it("rejects a missing GITHUB_APP_ID", () => {
      expect(() => loadEnv(validEnv({ GITHUB_APP_ID: undefined }))).toThrow(
        /GITHUB_APP_ID/,
      );
    });

    it("rejects a missing GITHUB_APP_PRIVATE_KEY", () => {
      expect(() =>
        loadEnv(validEnv({ GITHUB_APP_PRIVATE_KEY: undefined })),
      ).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    });

    it("rejects a missing GITHUB_APP_SLUG", () => {
      expect(() => loadEnv(validEnv({ GITHUB_APP_SLUG: undefined }))).toThrow(
        /GITHUB_APP_SLUG/,
      );
    });
  });

  describe("GitHub App OAuth client credentials (Task #26 create-new-repo hop)", () => {
    it("passes the client id + secret through", () => {
      const env = loadEnv(validEnv());
      expect(env.GITHUB_APP_CLIENT_ID).toBe(GITHUB_APP_CLIENT_ID);
      expect(env.GITHUB_APP_CLIENT_SECRET).toBe(GITHUB_APP_CLIENT_SECRET);
    });

    it("rejects a missing GITHUB_APP_CLIENT_ID", () => {
      expect(() =>
        loadEnv(validEnv({ GITHUB_APP_CLIENT_ID: undefined })),
      ).toThrow(/GITHUB_APP_CLIENT_ID/);
    });

    it("rejects a missing GITHUB_APP_CLIENT_SECRET", () => {
      expect(() =>
        loadEnv(validEnv({ GITHUB_APP_CLIENT_SECRET: undefined })),
      ).toThrow(/GITHUB_APP_CLIENT_SECRET/);
    });
  });

  describe("SECRETS_ENCRYPTION_KEY (Task #12)", () => {
    it("passes a valid 64-char hex key through", () => {
      const env = loadEnv(validEnv());
      expect(env.SECRETS_ENCRYPTION_KEY).toBe(SECRETS_ENCRYPTION_KEY);
    });

    it("accepts an uppercase hex key", () => {
      const key = "AB".repeat(32);
      const env = loadEnv(validEnv({ SECRETS_ENCRYPTION_KEY: key }));
      expect(env.SECRETS_ENCRYPTION_KEY).toBe(key);
    });

    it("rejects a missing SECRETS_ENCRYPTION_KEY", () => {
      expect(() =>
        loadEnv(validEnv({ SECRETS_ENCRYPTION_KEY: undefined })),
      ).toThrow(/SECRETS_ENCRYPTION_KEY/);
    });

    it("rejects a key that is not 64 hex chars (too short / non-hex / base64)", () => {
      for (const bad of [
        "a".repeat(63),
        "a".repeat(65),
        "z".repeat(64),
        Buffer.alloc(32).toString("base64"),
      ]) {
        expect(() =>
          loadEnv(validEnv({ SECRETS_ENCRYPTION_KEY: bad })),
        ).toThrow(/SECRETS_ENCRYPTION_KEY/);
      }
    });
  });

  describe("S3 object storage (Task #13)", () => {
    it("passes the endpoints/bucket/keys through and defaults the region", () => {
      const env = loadEnv(validEnv());
      expect(env.S3_ENDPOINT).toBe("http://minio:9000");
      expect(env.S3_PUBLIC_ENDPOINT).toBe("http://localhost:9000");
      expect(env.S3_BUCKET).toBe("supagloo-dev");
      expect(env.S3_ACCESS_KEY).toBe("supagloo");
      expect(env.S3_SECRET_KEY).toBe("supagloo-dev");
      expect(env.S3_REGION).toBe("us-east-1");
    });

    it("accepts an S3_REGION override", () => {
      const env = loadEnv(validEnv({ S3_REGION: "eu-west-1" }));
      expect(env.S3_REGION).toBe("eu-west-1");
    });

    it("rejects a missing required S3 var", () => {
      for (const key of [
        "S3_ENDPOINT",
        "S3_PUBLIC_ENDPOINT",
        "S3_BUCKET",
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
      ]) {
        expect(() => loadEnv(validEnv({ [key]: undefined })), key).toThrow(
          new RegExp(key),
        );
      }
    });

    it("rejects a non-http(s) endpoint (internal or public)", () => {
      expect(() =>
        loadEnv(validEnv({ S3_ENDPOINT: "minio:9000" })),
      ).toThrow(/S3_ENDPOINT/);
      expect(() =>
        loadEnv(validEnv({ S3_PUBLIC_ENDPOINT: "ftp://nope" })),
      ).toThrow(/S3_PUBLIC_ENDPOINT/);
    });
  });

  describe("SUPAGLOO_ENABLE_TEST_SEED (Task #10 seed gate)", () => {
    it("defaults to undefined when unset", () => {
      const env = loadEnv(validEnv());
      expect(env.SUPAGLOO_ENABLE_TEST_SEED).toBeUndefined();
    });

    it("passes the raw '1' flag through verbatim", () => {
      const env = loadEnv(validEnv({ SUPAGLOO_ENABLE_TEST_SEED: "1" }));
      expect(env.SUPAGLOO_ENABLE_TEST_SEED).toBe("1");
    });
  });
});
