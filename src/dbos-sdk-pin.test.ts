import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Plan row 45 / Step-11 item 17 (RX-3). The api is the PRODUCTION enqueuer into the
// worker-owned DBOS system schema: `makeDbosEnqueuer` (src/jobs/enqueuer.ts) opens a
// `DBOSClient` against `DBOS_DATABASE_URL`, and `DBOS_SYSTEM_DATABASE_SCHEMA` is unset in
// every Compose file — so this process writes `workflow_status` / `workflow_queue` rows in
// the SAME `dbos` schema the worker migrated, using the SDK's own table layout.
//
// That makes the SDK version a WIRE CONTRACT between two separately-installed services,
// not an ordinary dependency. It was measured breaking exactly that way: a re-resolved
// caret produced `column "debounce_deadline_epoch_ms" of relation "workflow_status" does
// not exist` on `POST /v1/projects` while every unit test here stayed green (they inject a
// fake enqueue seam and never touch a real client).
//
// The root repo carries the CROSS-repo half of this guard (`tests/unit/dbos-sdk-pin.test.ts`
// asserts root, api and dbos all declare the same exact spec). This is the api-local half,
// and it is the one that fires in the situation the finding describes — `npm install`
// inside this checkout, where nobody runs root's suite.
const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const lock = JSON.parse(
  readFileSync(resolve(process.cwd(), "package-lock.json"), "utf8"),
) as { packages?: Record<string, { version?: string }> };

const SDK = "@dbos-inc/dbos-sdk";

describe("DBOS SDK version pin (the production enqueue path)", () => {
  it("U-SDK-PIN-1: the declared spec is EXACT — no caret, tilde or range", () => {
    const spec = pkg.dependencies?.[SDK];
    expect(spec, `${SDK} must be a direct dependency of the api`).toBeTypeOf(
      "string",
    );
    // A caret here is the whole defect: `npm install <anything>` re-resolves it against
    // a `dbos` schema that was migrated by a different SDK build.
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("U-SDK-PIN-2: the installed tree matches the declared spec exactly", () => {
    const spec = pkg.dependencies?.[SDK];
    const installed = lock.packages?.[`node_modules/${SDK}`]?.version;
    expect(installed, "lockfile has no entry for the SDK").toBeTypeOf("string");
    expect(installed).toBe(spec);
  });
});
