import { z } from "zod";

/**
 * Zod-validated environment for the API service. Scope grows per task: Task #8
 * added the Postgres connection string + server-bind settings; Task #9 adds the
 * outbound-provider base-URL convention. S3 / secrets / provider-key vars arrive
 * with the tasks that use them.
 *
 * URL-shaped vars are validated with an explicit scheme check (not zod's
 * `.url()`) so the rejection message is precise and version-agnostic across zod
 * releases.
 */
const POSTGRES_URL = /^postgres(?:ql)?:\/\/.+/;
const HTTP_URL = /^https?:\/\/.+/;
// A 32-byte AES-256-GCM key, supplied as 64 hex chars (`openssl rand -hex 32`).
// Matches database-lib `secrets.ts`'s `KEY_HEX`; validated here so a misconfigured
// key fails fast at boot rather than on the first encrypt/decrypt.
const SECRETS_KEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * A provider base URL: http(s), with the REAL provider URL as the default so
 * production needs zero config. The Task #9 test Compose overlay overrides these
 * to point at the in-network stub servers (`http://github-stub:8080`, etc.).
 * When `supagloo-nodejs-dbos` is bootstrapped (Task 15) it adopts these SAME var
 * names + defaults verbatim.
 */
const providerBaseUrl = (defaultUrl: string) =>
  z
    .string()
    .min(1)
    .refine((value) => HTTP_URL.test(value), {
      message: "must be an http:// or https:// base URL",
    })
    .default(defaultUrl);

export const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => POSTGRES_URL.test(value), {
      message:
        "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    }),
  // Task #18 (design-delta §5.1): the DBOS SYSTEM database (`supagloo_dbos`). The API
  // enqueues scaffold/git-ops jobs with `DBOSClient` against this DB (it never runs the
  // DBOS runtime). A DIFFERENT database from DATABASE_URL (the app db). Required —
  // fail-fast at boot, since the create-project endpoint cannot enqueue without it.
  DBOS_DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => POSTGRES_URL.test(value), {
      message:
        "DBOS_DATABASE_URL must be a postgres:// or postgresql:// connection string",
    }),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // GitHub splits hosts: REST API (installation tokens, repos, PRs) vs the
  // user-authorization OAuth host (create-new-repo code exchange).
  GITHUB_API_BASE_URL: providerBaseUrl("https://api.github.com"),
  GITHUB_OAUTH_BASE_URL: providerBaseUrl("https://github.com"),
  OPENROUTER_BASE_URL: providerBaseUrl("https://openrouter.ai"),
  GLOO_BASE_URL: providerBaseUrl("https://platform.ai.gloo.com"),
  // Confirmed against https://developers.youversion.com/api-usage: base URL is
  // https://api.youversion.com, versioned paths (e.g. /v1/bibles/{id}/passages/{ref}).
  // Still unverified at implementation time (§9-Q10): the X-YVP-App-Key auth
  // header convention, and which bible IDs map to KJV/BSB.
  YOUVERSION_BASE_URL: providerBaseUrl("https://api.youversion.com"),

  // Task #10 seed gate (§9-Q9). A raw string flag, kept verbatim (not coerced to
  // boolean) so the route can enforce the exact `=== '1'` contract. The seed
  // endpoint additionally requires NODE_ENV !== 'production'; unset in prod.
  SUPAGLOO_ENABLE_TEST_SEED: z.string().optional(),

  // Task #11 GitHub App (design-delta §2.3/§9-Q1). App-LEVEL secrets/config — one
  // pair per app registration, shared by the API and DBOS, NOT per-user data — so
  // they live in env config and bypass §2.10's per-user AES-256-GCM scheme. The
  // API signs ~10-min App JWTs (`GITHUB_APP_ID` issuer + `GITHUB_APP_PRIVATE_KEY`)
  // to verify installations and mint installation tokens, and builds the hosted
  // install-picker URL `{GITHUB_OAUTH_BASE_URL}/apps/{GITHUB_APP_SLUG}/installations/new`
  // (the slug cannot be derived from the numeric app id). Required — fail-fast at
  // boot. The private key is PKCS#1/PKCS#8 PEM; escaped `\n` is normalized at the
  // client boundary, so the raw string is carried through here unparsed.
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),

  // Task #12 application-secrets key (design-delta §2.10). The single AES-256-GCM
  // key the API uses to encrypt/decrypt per-user provider secrets (the OpenRouter
  // API key, the Gloo client secret) via database-lib's `encryptSecret`/
  // `decryptSecret`. A 64-hex-char (32-byte) value, distinct per environment
  // (`openssl rand -hex 32`). Required — fail-fast at boot. NOT per-user data; one
  // key per deployment, shared by the API and DBOS.
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .refine((value) => SECRETS_KEY_HEX.test(value), {
      message:
        "SECRETS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes); " +
        "generate one with `openssl rand -hex 32`",
    }),

  // Task #13 S3 object storage (design-delta §4/§8). The API presigns DOWNLOAD URLs
  // only (uploads are server-side worker ops; deletes are the cleanup workflow's).
  // TWO endpoints: S3_ENDPOINT is the internal Docker-network address (worker ops);
  // S3_PUBLIC_ENDPOINT is the browser-reachable address that presigned URLs MUST be
  // signed against (a URL signed against minio:9000 is unreachable from a browser).
  // forcePathStyle is applied in the client factory (MinIO has no vhost-style bucket
  // DNS). Required (fail-fast) — there is no correct default endpoint/bucket/
  // credential, and a wrong one silently signs broken URLs. Only S3_REGION defaults.
  // Dev values point at the Compose MinIO; prod uses the Railway bucket.
  S3_ENDPOINT: z
    .string()
    .min(1)
    .refine((value) => HTTP_URL.test(value), {
      message: "S3_ENDPOINT must be an http:// or https:// URL",
    }),
  S3_PUBLIC_ENDPOINT: z
    .string()
    .min(1)
    .refine((value) => HTTP_URL.test(value), {
      message: "S3_PUBLIC_ENDPOINT must be an http:// or https:// URL",
    }),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate the environment. Throws a single, actionable error listing
 * every problem when validation fails (fail-fast at boot). Accepts an injected
 * source for testing; defaults to `process.env`.
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  return result.data;
}
