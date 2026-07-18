import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const VALID_DB_URL = "postgres://supagloo:supagloo@localhost:5432/supagloo";

describe("loadEnv", () => {
  it("accepts a valid postgres DATABASE_URL and applies server-bind defaults", () => {
    const env = loadEnv({ DATABASE_URL: VALID_DB_URL });
    expect(env.DATABASE_URL).toBe(VALID_DB_URL);
    expect(env.PORT).toBe(4000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.NODE_ENV).toBe("development");
  });

  it("accepts the postgresql:// scheme and coerces overrides", () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://u:p@db:5432/app",
      PORT: "8080",
      HOST: "127.0.0.1",
      NODE_ENV: "production",
    });
    expect(env.DATABASE_URL).toBe("postgresql://u:p@db:5432/app");
    expect(env.PORT).toBe(8080);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.NODE_ENV).toBe("production");
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects an empty DATABASE_URL", () => {
    expect(() => loadEnv({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL scheme", () => {
    expect(() => loadEnv({ DATABASE_URL: "http://example.com/db" })).toThrow(
      /postgres/i,
    );
  });

  it("rejects a non-numeric PORT", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: VALID_DB_URL, PORT: "not-a-number" }),
    ).toThrow();
  });

  describe("provider base URLs (Task #9 convention)", () => {
    it("defaults to the real provider URLs when unset", () => {
      const env = loadEnv({ DATABASE_URL: VALID_DB_URL });
      expect(env.GITHUB_API_BASE_URL).toBe("https://api.github.com");
      expect(env.GITHUB_OAUTH_BASE_URL).toBe("https://github.com");
      expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai");
      expect(env.GLOO_BASE_URL).toBe("https://platform.ai.gloo.com");
      expect(env.YOUVERSION_BASE_URL).toBe("https://api.youversion.com");
    });

    it("accepts overrides that point at http:// stub servers", () => {
      const env = loadEnv({
        DATABASE_URL: VALID_DB_URL,
        GITHUB_API_BASE_URL: "http://github-stub:8080",
        GITHUB_OAUTH_BASE_URL: "http://github-stub:8080",
        OPENROUTER_BASE_URL: "http://openrouter-stub:8080",
        GLOO_BASE_URL: "http://gloo-stub:8080",
        YOUVERSION_BASE_URL: "http://youversion-stub:8080",
      });
      expect(env.OPENROUTER_BASE_URL).toBe("http://openrouter-stub:8080");
      expect(env.GITHUB_API_BASE_URL).toBe("http://github-stub:8080");
    });

    it("rejects a non-http(s) provider base URL", () => {
      expect(() =>
        loadEnv({ DATABASE_URL: VALID_DB_URL, OPENROUTER_BASE_URL: "ftp://nope" }),
      ).toThrow(/OPENROUTER_BASE_URL/);
    });
  });
});
