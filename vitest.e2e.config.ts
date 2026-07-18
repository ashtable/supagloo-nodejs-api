import { defineConfig } from "vitest/config";

// E2E config: boots the REAL Fastify server (real listen + real HTTP fetch), no
// browser and no docker — the non-UI e2e style. One file at a time, generous
// timeouts for server startup.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
