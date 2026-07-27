import { afterEach, describe, expect, it } from "vitest";
import {
  DBOS_DEFAULT_SYSTEM_SCHEMA,
  LANE_SCHEMA_PREFIX,
  LANE_SCHEMA_SUFFIX_ENV,
  assertLaneSchemaName,
  laneSystemSchema,
} from "./dbos-lane-isolation";

// Unit cover for the e2e lane-isolation seam (Part B). The DB-touching halves
// (`resetLaneSchema`, `assertLaneRuntimeIsolated`, `assertWorkflowIsolated`) are
// exercised for real by the four e2e specs — this file pins the PURE half, which is
// where the safety properties live: the schema-name grammar is the ONLY thing standing
// between an interpolated `DROP SCHEMA … CASCADE` and the production `dbos` schema.

afterEach(() => {
  delete process.env[LANE_SCHEMA_SUFFIX_ENV];
});

describe("dbos lane isolation — schema naming", () => {
  it('U-DLI1: laneSystemSchema("api_render") is dbos_e2e_api_render', () => {
    expect(laneSystemSchema("api_render")).toBe("dbos_e2e_api_render");
    expect(LANE_SCHEMA_PREFIX).toBe("dbos_e2e_");
  });

  it("U-DLI2: SUPAGLOO_DBOS_E2E_SCHEMA_SUFFIX appends, so two parallel runs get different schemas", () => {
    process.env[LANE_SCHEMA_SUFFIX_ENV] = "ci7";
    const a = laneSystemSchema("api_render");
    process.env[LANE_SCHEMA_SUFFIX_ENV] = "ci8";
    const b = laneSystemSchema("api_render");

    expect(a).toBe("dbos_e2e_api_render_ci7");
    expect(b).toBe("dbos_e2e_api_render_ci8");
    expect(a).not.toBe(b);

    // Whitespace-only is treated as unset, so an empty CI variable does not produce a
    // trailing underscore (a *different* schema from the default, silently).
    process.env[LANE_SCHEMA_SUFFIX_ENV] = "   ";
    expect(laneSystemSchema("api_render")).toBe("dbos_e2e_api_render");
  });

  it("U-DLI3: assertLaneSchemaName(\"dbos\") THROWS — the production schema can never be dropped", () => {
    expect(() => assertLaneSchemaName(DBOS_DEFAULT_SYSTEM_SCHEMA)).toThrow(
      /dbos_e2e_/,
    );
    expect(() => assertLaneSchemaName("public")).toThrow();
    expect(() => assertLaneSchemaName("")).toThrow();
    // A prefix-only name has no lane, so it would be shared by every lane.
    expect(() => assertLaneSchemaName(LANE_SCHEMA_PREFIX)).toThrow();
  });

  it("U-DLI4: a name longer than 63 bytes THROWS (Postgres truncates identifiers silently, which would re-share a schema)", () => {
    const justFits = `${LANE_SCHEMA_PREFIX}${"a".repeat(63 - LANE_SCHEMA_PREFIX.length)}`;
    expect(justFits).toHaveLength(63);
    expect(() => assertLaneSchemaName(justFits)).not.toThrow();

    const oneTooLong = `${justFits}a`;
    expect(() => assertLaneSchemaName(oneTooLong)).toThrow(/63/);
    // …and the same length reached through the suffix escape hatch.
    process.env[LANE_SCHEMA_SUFFIX_ENV] = "b".repeat(60);
    expect(() => laneSystemSchema("api_render")).toThrow(/63/);
  });

  it("U-DLI5: a name containing a quote, a semicolon, a space or an uppercase letter THROWS", () => {
    for (const bad of [
      `${LANE_SCHEMA_PREFIX}a"b`,
      `${LANE_SCHEMA_PREFIX}a;drop`,
      `${LANE_SCHEMA_PREFIX}a b`,
      `${LANE_SCHEMA_PREFIX}Api`,
      `${LANE_SCHEMA_PREFIX}a-b`,
      `${LANE_SCHEMA_PREFIX}a.b`,
      `x${LANE_SCHEMA_PREFIX}a`,
    ]) {
      expect(() => assertLaneSchemaName(bad), bad).toThrow();
    }
    // …and the lane argument cannot smuggle any of it in either.
    expect(() => laneSystemSchema('a" CASCADE; DROP SCHEMA "dbos')).toThrow();
  });

  it("U-DLI6: DBOS_DEFAULT_SYSTEM_SCHEMA matches the SDK's own default", async () => {
    // Deep-imported by PATH, not by package specifier: the SDK's `exports` map does not
    // expose `./dist/src/config.js`. Reading the real default here means an SDK bump
    // that changes it fails in THIS test rather than silently re-coupling four e2e
    // specs to a schema the Compose worker also polls.
    const { translateDbosConfig } = await import(
      "../../node_modules/@dbos-inc/dbos-sdk/dist/src/config.js"
    );
    const resolved = translateDbosConfig({
      name: "lane-isolation-default-probe",
      systemDatabaseUrl:
        "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos",
    });
    expect(resolved.systemDatabaseSchemaName).toBe(DBOS_DEFAULT_SYSTEM_SCHEMA);
  });
});
