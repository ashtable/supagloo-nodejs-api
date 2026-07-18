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
