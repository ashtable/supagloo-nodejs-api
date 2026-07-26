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
 * production needs zero config.
 *
 * As of task 62 (design-delta §11) the test Compose overlay overrides **NO** provider
 * base URL at all: task 34-E8 (§10.7) removed the OpenRouter/Gloo/YouVersion overrides,
 * and task 62 removed the last two — `GITHUB_API_BASE_URL` and `GITHUB_OAUTH_BASE_URL`
 * — when the github-stub was retired. All four providers are now exercised for real by
 * the e2e suites, so these defaults are the values every environment actually uses.
 * The override MECHANISM stays: it is still the seam a future in-network fake or a
 * GitHub Enterprise host would use, and `http://` is still accepted for that reason.
 * When `supagloo-nodejs-dbos` is bootstrapped (Task 15) it adopts these SAME var names
 * + defaults verbatim.
 */
const providerBaseUrl = (defaultUrl: string) =>
  z
    .string()
    .min(1)
    .refine((value) => HTTP_URL.test(value), {
      message: "must be an http:// or https:// base URL",
    })
    .default(defaultUrl);

/**
 * A provider base URL with NO default of its own, because its default is another
 * variable's *resolved* value rather than a constant (plan row 66). Same http(s)
 * validation, same override mechanism; the resolution happens after parse in
 * `loadEnv` so an override of the public var still flows through to the internal one.
 */
const optionalProviderBaseUrl = z
  .string()
  .min(1)
  .refine((value) => HTTP_URL.test(value), {
    message: "must be an http:// or https:// base URL",
  })
  .optional();

const baseEnvSchema = z.object({
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
  //
  // …and the OAuth host itself splits again, PUBLIC vs INTERNAL (plan row 66). One
  // variable used to serve three call sites of two different KINDS:
  //   • BROWSER — `installUrl()` and `buildAuthorizeUrl()` are URLs the USER's own
  //     machine opens, so they must resolve from outside the Docker network;
  //   • SERVER  — `exchangeCode()` is a POST made by this process.
  // Because they shared one value, a containerised api could not have its exchange
  // pointed anywhere without also moving the browser's redirect target, which is
  // exactly plan row 62 item (e)'s DNS_PROBE_FINISHED_NXDOMAIN. GITHUB_OAUTH_BASE_URL
  // keeps its PUBLIC meaning and GITHUB_OAUTH_INTERNAL_BASE_URL is the server-side
  // half, used ONLY by `exchangeCode`.
  //
  // DELIBERATE DEVIATION from design-delta §11.4's "mirroring S3_ENDPOINT /
  // S3_PUBLIC_ENDPOINT": under the S3 convention the UNSUFFIXED name is the internal
  // one, which would have silently changed the meaning of a variable every deployed
  // environment already sets. Naming the NEW one for the NEW meaning is the only
  // direction that preserves "production needs zero config" for existing deployments.
  // Unset ⇒ it resolves to GITHUB_OAUTH_BASE_URL ⇒ behaviour identical to before the
  // split, which is also why it is NOT copying S3's required-no-default posture.
  GITHUB_API_BASE_URL: providerBaseUrl("https://api.github.com"),
  GITHUB_OAUTH_BASE_URL: providerBaseUrl("https://github.com"),
  GITHUB_OAUTH_INTERNAL_BASE_URL: optionalProviderBaseUrl,
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

  // Plan row 66 — TEST-ONLY, and the ONE GitHub credential that ever enters a
  // product container. It is read by exactly one place, `src/routes/test-github-oauth.ts`,
  // which is registered only behind the SAME double gate as POST /v1/test/seed above
  // (NODE_ENV !== 'production' AND SUPAGLOO_ENABLE_TEST_SEED === '1'). It MUST be
  // absent in production, so it is optional here rather than required — but the route
  // FAILS FAST naming this variable when the gates pass and the value is missing, so
  // "optional" can never degrade into a placeholder token that 401s far from its cause.
  //
  // It is NOT GITHUB_E2E_PAT_TOKEN. That one is a broad classic-`repo` credential over
  // an account holding the user's real repositories, and §11.8's "it never enters any
  // container" property stays intact. This is a purpose-built fine-grained token with
  // repository-CREATION rights only and deliberately no `delete_repo` (the cleanup
  // script archives, never deletes).
  GITHUB_E2E_EXCHANGE_TOKEN: z.string().optional(),

  // Task #11 GitHub App (design-delta §2.3/§9-Q1). App-LEVEL secrets/config — one
  // pair per app registration, shared by the API and DBOS, NOT per-user data — so
  // they live in env config and bypass §2.10's per-user AES-256-GCM scheme. The
  // API signs ~10-min App JWTs (`GITHUB_APP_ID` issuer + `GITHUB_APP_PRIVATE_KEY`)
  // to verify installations and mint installation tokens, and builds the hosted
  // install-picker URL `{GITHUB_OAUTH_BASE_URL}/apps/{GITHUB_APP_SLUG}/installations/new`
  // — the PUBLIC base, because the user's BROWSER opens that URL in a new tab; it is
  // never the internal one (the slug cannot be derived from the numeric app id).
  // Required — fail-fast at
  // boot. The private key is PKCS#1/PKCS#8 PEM; escaped `\n` is normalized at the
  // client boundary, so the raw string is carried through here unparsed.
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),

  // Task #26 create-new-repo JIT hop (design-delta §2.3/§6b). The GitHub App's
  // OAuth client credentials — DISTINCT from the App's private key above. Used to
  // exchange a user-authorization `code` for a short-lived USER token
  // (`POST {GITHUB_OAUTH_INTERNAL_BASE_URL}/login/oauth/access_token` — the INTERNAL
  // base since plan row 66, because this is a server-to-server POST; the browser's
  // authorize redirect at `{GITHUB_OAUTH_BASE_URL}/login/oauth/authorize` is the
  // public one), which creates the new
  // repo in the user's account and adds it to a `selected`-mode installation, then
  // is discarded. App-level (one pair per app registration), so like the App
  // id/key/slug they live in env config and bypass §2.10's per-user encryption.
  // Required — fail-fast at boot, since create-new-repo cannot proceed without them.
  GITHUB_APP_CLIENT_ID: z.string().min(1),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1),

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

/**
 * The parsed environment, with the one derived value resolved (plan row 66):
 * `GITHUB_OAUTH_INTERNAL_BASE_URL` falls back to the PUBLIC base rather than to a
 * constant, so overriding only `GITHUB_OAUTH_BASE_URL` (a GitHub Enterprise host,
 * say) still moves both halves together, and an environment that sets neither behaves
 * exactly as it did before the split.
 */
export const envSchema = baseEnvSchema.transform((env) => ({
  ...env,
  GITHUB_OAUTH_INTERNAL_BASE_URL:
    env.GITHUB_OAUTH_INTERNAL_BASE_URL ?? env.GITHUB_OAUTH_BASE_URL,
}));

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
