import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRootRepoDir } from "../../src/testing/github-e2e";

/**
 * Load the ROOT repo's untracked `.env` into every vitest WORKER (task-62 D24).
 *
 * vitest runs `globalSetup` in the main process but the spec files in worker
 * processes, so anything globalSetup puts on `process.env` is invisible to the tests.
 * The real-GitHub e2e credentials (`GITHUB_APP_*`, `GITHUB_E2E_PAT_TOKEN`) are read
 * INSIDE the specs, so they must be loaded here — as a `setupFiles` entry, which does
 * run per worker. Modelled on nextjs's existing `tests/e2e/load-env.ts`.
 *
 * `process.loadEnvFile` (Node ≥20.12; this repo runs Node 24) deliberately does NOT
 * override an already-set variable, so an explicit `GITHUB_APP_ID=… npm run test:e2e`
 * still wins, and CI-provided values are never clobbered.
 *
 * Failure here is SILENT ON PURPOSE — and this is the one place a silent path is
 * correct. Not every api e2e spec needs GitHub (`renders.e2e.ts` has zero GitHub
 * egress by design, `auth.e2e.ts` and `files.e2e.ts` likewise), so a missing root
 * `.env` must not fail those. The specs that DO need credentials call
 * `resolveGithubE2eContext()`, whose per-variable fail-fast names the var, this file
 * and `.env.example` — an actionable error at the point of use beats an unactionable
 * one at import time. (plan row 56 item (2): the thing that must never be silent is a
 * SKIPPED TEST, not an optional env file.)
 *
 * Secrets stay in the untracked `.env` and are never inlined into tracked config
 * (HARD RULE 3); nothing here ever prints a value.
 */

const rootDir = resolveRootRepoDir();
const envFile = join(rootDir, ".env");

if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env is the operator's problem to see at point of use, not a
    // reason to abort suites that need nothing from it.
  }
}
