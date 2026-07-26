import { defineConfig } from "vitest/config";

// E2E config: boots the REAL Fastify server (real listen + real HTTP fetch), no
// browser. The suites need real Postgres + MinIO from the root Compose stack, and the
// GitHub-touching suites reach REAL github.com / api.github.com (task-62 half (A) —
// there is no github-stub any more). globalSetup reuse-or-spawns the infra.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    // Real GitHub is slower and far less deterministic than the retired stub: fixture
    // repo creation, the two eventual-consistency gates and real Contents writes all
    // happen inside a spec's own timeout (task-62 preflight §6.3).
    testTimeout: 120_000,
    // Generous hook timeout: globalSetup may spin up Postgres + MinIO
    // (reuse-or-spawn), and a beforeAll may provision fixture repos, before any test runs.
    hookTimeout: 300_000,
    fileParallelism: false,
    globalSetup: ["tests/e2e/global-setup.ts"],
    // task-62 D24: globalSetup runs in the MAIN process, spec files in WORKERS, so the
    // root .env must be loaded per worker or the real-GitHub credentials the specs read
    // are simply absent.
    setupFiles: ["tests/e2e/load-root-env.ts"],
  },
});
