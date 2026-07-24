/**
 * Loud-skip gate for the OPTIONAL live YouVersion sign-in e2e (design-delta
 * §10.4b / §10.8).
 *
 * The live userinfo round-trip needs a real YouVersion access token from a
 * dedicated test account. That token only comes from an INTERACTIVE browser login
 * (Sign in with YouVersion is an OAuth flow that cannot be automated in the
 * harness), so it is supplied out-of-band as `YOUVERSION_E2E_ACCESS_TOKEN`.
 *
 * This var is the SOLE e2e secret permitted to SKIP its spec when unset — every
 * OTHER provider secret FAILS the e2e global-setup fast (§10.8), because "a gating
 * suite that silently skips its provider tests is a green lie." But even this
 * skip must be LOUD: a visible `console.warn` naming the var, never a silent
 * no-op / absence.
 *
 * The gating decision is factored out here (not inlined in the spec), mirroring
 * `resolveConnectionSeedCreds`, so it is unit-testable with an INJECTED env
 * (`youversion-live-e2e.test.ts`) — no live provider, no docker.
 *
 * TEST-ONLY infrastructure: excluded from the shipped `dist/` build via
 * `tsconfig.build.json`'s `src/testing/**` exclude.
 */

/** The env var (design-delta §10.4b/§10.8; already in `.env.example`). */
export const YOUVERSION_E2E_TOKEN_VAR = "YOUVERSION_E2E_ACCESS_TOKEN";

export interface YouVersionLiveGate {
  /** True iff a non-blank token is present → the live spec should RUN. */
  enabled: boolean;
  /** The resolved raw token when enabled; `null` when skipping. */
  token: string | null;
  /** Actionable warning to `console.warn` when skipping; `null` when enabled. */
  skipWarning: string | null;
}

type EnvSource = Record<string, string | undefined>;

/**
 * Resolve whether the optional live YouVersion sign-in spec should run. A
 * missing or whitespace-only `YOUVERSION_E2E_ACCESS_TOKEN` is treated as absent
 * (mirrors `resolveConnectionSeedCreds`) and yields a LOUD, actionable skip
 * warning — never a silent no-op. Pure + env-injectable for unit testing.
 */
export function resolveYouVersionLiveGate(
  env: EnvSource = process.env,
): YouVersionLiveGate {
  const raw = env[YOUVERSION_E2E_TOKEN_VAR];
  const present = raw !== undefined && raw.trim() !== "";

  if (present) {
    return { enabled: true, token: raw, skipWarning: null };
  }

  return {
    enabled: false,
    token: null,
    skipWarning:
      `[SKIP] Live YouVersion sign-in e2e SKIPPED: ${YOUVERSION_E2E_TOKEN_VAR} is ` +
      `unset. This is the ONE deliberately-optional real spec (design-delta ` +
      `§10.4b / §10.8): the live userinfo round-trip needs a dedicated test ` +
      `account's YouVersion access token, which only comes from an interactive ` +
      `browser login and cannot be minted in the harness. Set ` +
      `${YOUVERSION_E2E_TOKEN_VAR} (see .env.example) to run it. Every OTHER e2e ` +
      `provider secret FAILS FAST instead of skipping — only this one may skip, ` +
      `and it skips LOUDLY here, never silently.`,
  };
}
