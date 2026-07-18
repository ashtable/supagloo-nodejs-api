import { defineConfig } from "vitest/config";

// Unit config: fast, in-process tests co-located next to source
// (src/**/*.test.ts). No docker, no live infra. E2E (real HTTP / real stack)
// lives under tests/e2e/*.e2e.ts and runs via vitest.e2e.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "tests/e2e/**"],
  },
});
