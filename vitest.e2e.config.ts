import { defineConfig } from "vitest/config";

// E2E config: boots the REAL Fastify server (real listen + real HTTP fetch), no
// browser. The auth suite (Task #10) additionally needs real Postgres + the
// containerized YouVersion stub; globalSetup reuse-or-spawns them.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 30_000,
    // Generous hook timeout: globalSetup may spin up Postgres + the YouVersion
    // stub (reuse-or-spawn) before any test runs.
    hookTimeout: 200_000,
    fileParallelism: false,
    globalSetup: ["tests/e2e/global-setup.ts"],
  },
});
