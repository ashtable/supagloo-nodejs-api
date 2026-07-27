import { createPrismaClient } from "@supagloo/database-lib";

/**
 * PER-LANE DBOS SYSTEM-SCHEMA ISOLATION for this repo's e2e specs.
 *
 * THE PROBLEM. Four api e2e specs register a STAND-IN workflow under the REAL shared
 * workflow name on the REAL shared queue (deliberately — exercising the real API↔DBOS
 * name contract is the point of those specs). The api enqueues with NO `appVersion`, so
 * every row lands with `application_version = NULL`, and the SDK's dequeue predicate is
 *
 *     WHERE status = $1 AND queue_name = $2
 *       AND (application_version IS NULL OR application_version = $3)
 *
 * A NULL-version row is therefore dequeuable by ANY executor polling that queue. When the
 * root Compose `dbos` container is up, the REAL containerised worker races the in-process
 * stand-in and usually wins, failing the job against fixture rows that only exist in the
 * test's imagination. The specs used to "solve" this with a header note asserting the
 * container was stopped — a precondition that is unsatisfiable across a full sweep, since
 * the root repo's own e2e lane and nextjs's render lane both bring `dbos` UP and leave it
 * up on purpose.
 *
 * THE FIX. Point the in-process runtime AND the enqueuer at a per-lane SCHEMA inside the
 * SAME `supagloo_dbos` database, via the SDK's own `systemDatabaseSchemaName`. The two
 * executors then read and write disjoint `workflow_status` tables, so neither can see the
 * other's rows IN EITHER DIRECTION. Note what is deliberately NOT done:
 *
 *   • NOT `appVersion` pinning — the predicate's `IS NULL` disjunction means a
 *     version-pinned stand-in would still steal NULL-versioned REAL enqueues. That is
 *     worse than the bug being fixed.
 *   • NOT a third database — the documented topology is two logical databases, and a
 *     schema keeps that sentence true.
 *   • NOT runtime-constructed queue or workflow names — static registration is a hard
 *     constraint, and the real shared names are exactly what these specs exist to prove.
 *   • NOT a conditional skip or a warn — a lane must never mark itself optional. The
 *     `assert*` helpers below are POSITIVE proof that isolation is in effect, so a future
 *     regression that drops the config fails loudly instead of silently re-coupling.
 *
 * The schema self-provisions: the SDK's first system migration is
 * `CREATE SCHEMA IF NOT EXISTS "<schemaName>"`, so no Compose or Postgres change is needed.
 *
 * A NEAR-IDENTICAL COPY LIVES AT `supagloo-nodejs-dbos/src/testing/dbos-lane-isolation.ts`.
 * The duplication is deliberate — but the reason is NARROWER than this note used to claim,
 * and the difference matters. The argument is about the file's LOCATION: routing it through
 * the root checkout would make specs that need no root checkout today (renders,
 * project-jobs) depend on one.
 *
 * It is NOT that the copies "cannot meaningfully diverge". Only the lane schema NAME is
 * naturally per-repo (the two repos must never share one). Everything between the
 * BEGIN/END markers below is a different kind of thing: `LANE_SCHEMA_PREFIX`,
 * `MAX_PG_IDENTIFIER_BYTES`, `LANE_SCHEMA_RE` and `assertLaneSchemaName` are ONE rule, and
 * that rule is the only thing standing between an interpolated `DROP SCHEMA … CASCADE` and
 * the production `"dbos"` schema. A copy that quietly loosened its regex or raised its byte
 * cap would look exactly like this one and would still pass its own repo's suite. Those
 * lines are therefore byte-identical across both repos and HELD that way by the root
 * repo's `tests/unit/dbos-lane-isolation-drift.test.ts`. Prose, error wording and
 * everything outside the markers are free to differ, and do.
 */

// --- BEGIN SHARED DDL SAFETY (byte-identical across api + dbos; drift-guarded) ---

/** The SDK's own default system schema. Pinned here so an SDK bump that changes it fails
 *  in `dbos-lane-isolation.test.ts` (U-DLI6) rather than as a silent re-coupling. */
export const DBOS_DEFAULT_SYSTEM_SCHEMA = "dbos";

/** The ONE authored copy of the lane-schema literal in this repo. */
export const LANE_SCHEMA_PREFIX = "dbos_e2e_";

/** Optional decoration for genuinely parallel runs (two CI jobs, one Postgres). Unset by
 *  default, because `fileParallelism: false` means specs within a repo never overlap. */
export const LANE_SCHEMA_SUFFIX_ENV = "SUPAGLOO_DBOS_E2E_SCHEMA_SUFFIX";

/** Postgres truncates identifiers past this SILENTLY — which would re-share a schema
 *  between two lanes without saying so. Rejected rather than truncated. */
const MAX_PG_IDENTIFIER_BYTES = 63;

const LANE_SCHEMA_RE = new RegExp(`^${LANE_SCHEMA_PREFIX}[a-z0-9_]+$`);

/**
 * Shape gate. Throws unless the name is `dbos_e2e_<lowercase identifier>` and fits in a
 * Postgres identifier. This is the ONLY thing that makes `resetLaneSchema`'s interpolated
 * DDL safe: `"dbos"` can never match, and no quote, semicolon, space or uppercase letter
 * can survive.
 */
export function assertLaneSchemaName(name: string): void {
  if (!LANE_SCHEMA_RE.test(name)) {
    throw new Error(
      `Refusing to use "${name}" as a DBOS lane system schema: it must match ` +
        `${LANE_SCHEMA_PREFIX}<lowercase letters, digits, underscores>. This gate is what ` +
        `keeps the interpolated DROP SCHEMA away from the production "${DBOS_DEFAULT_SYSTEM_SCHEMA}" schema.`,
    );
  }
  const bytes = Buffer.byteLength(name, "utf8");
  if (bytes > MAX_PG_IDENTIFIER_BYTES) {
    throw new Error(
      `DBOS lane system schema "${name}" is ${bytes} bytes; Postgres truncates identifiers ` +
        `past ${MAX_PG_IDENTIFIER_BYTES} SILENTLY, which would make two lanes share one schema. ` +
        `Shorten the lane name or ${LANE_SCHEMA_SUFFIX_ENV}.`,
    );
  }
}

/**
 * `dbos_e2e_<lane>` — plus `_<suffix>` when `SUPAGLOO_DBOS_E2E_SCHEMA_SUFFIX` is set.
 * Deterministic per lane by default, so schemas are reused run to run and nothing
 * accumulates; `resetLaneSchema` is what makes that reuse safe.
 */
export function laneSystemSchema(lane: string): string {
  const suffix = (process.env[LANE_SCHEMA_SUFFIX_ENV] ?? "").trim();
  const name = `${LANE_SCHEMA_PREFIX}${lane}${suffix ? `_${suffix}` : ""}`;
  assertLaneSchemaName(name);
  return name;
}

// --- END SHARED DDL SAFETY ---

interface SchemaTarget {
  systemDatabaseUrl: string;
  schema: string;
}

async function withSystemDb<T>(
  systemDatabaseUrl: string,
  fn: (db: {
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
    $queryRawUnsafe<R = unknown>(sql: string, ...values: unknown[]): Promise<R>;
  }) => Promise<T>,
): Promise<T> {
  // The api has no `pg` dependency; db-lib's Prisma factory is already here and raw
  // queries do not require a matching model, so no new dependency is introduced.
  const db = createPrismaClient({ connectionString: systemDatabaseUrl });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

/**
 * Guarded `DROP SCHEMA IF EXISTS "<name>" CASCADE`. Run BEFORE `DBOS.launch()`.
 *
 * Self-heals a crashed previous run: without it, a leftover PENDING row from an earlier
 * run of the SAME spec would be adopted by DBOS's recovery sweep at launch (same
 * `executor_id = "local"`, same auto-computed application version) and re-executed.
 */
export async function resetLaneSchema({
  systemDatabaseUrl,
  schema,
}: SchemaTarget): Promise<void> {
  assertLaneSchemaName(schema);
  await withSystemDb(systemDatabaseUrl, async (db) => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
}

function isolationFailure(detail: string): Error {
  return new Error(
    `DBOS lane isolation is NOT in effect: ${detail} ` +
      `Without it the containerised Compose \`dbos\` worker polls the same queues under the ` +
      `same shared workflow names as this spec's in-process stand-in, and the two race. ` +
      `Set systemDatabaseSchemaName on BOTH the runtime (DBOS.setConfig / launchDbos) and ` +
      `the enqueuer (makeDbosEnqueuer / DBOSClient.create) — see src/testing/dbos-lane-isolation.ts.`,
  );
}

async function regclassOf(
  db: { $queryRawUnsafe<R>(sql: string, ...v: unknown[]): Promise<R> },
  qualified: string,
): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ reg: string | null }>>(
    "SELECT to_regclass($1)::text AS reg",
    qualified,
  );
  return rows[0]?.reg ?? null;
}

async function countRows(
  db: { $queryRawUnsafe<R>(sql: string, ...v: unknown[]): Promise<R> },
  sql: string,
  ...values: unknown[]
): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(sql, ...values);
  return Number(rows[0]?.n ?? 0);
}

/**
 * POSITIVE proof, runtime half. Call right after `DBOS.launch()` + `registerQueue(...)`.
 * No enqueue required. Throws — never warns, never skips.
 */
export async function assertLaneRuntimeIsolated({
  systemDatabaseUrl,
  schema,
}: SchemaTarget): Promise<void> {
  if (schema === DBOS_DEFAULT_SYSTEM_SCHEMA) {
    throw isolationFailure(
      `this spec's system schema is "${schema}", the very schema the Compose worker polls.`,
    );
  }
  assertLaneSchemaName(schema);

  await withSystemDb(systemDatabaseUrl, async (db) => {
    // (2) The runtime genuinely provisioned the lane schema rather than silently
    //     falling back to the default.
    if ((await regclassOf(db, `"${schema}".workflow_status`)) === null) {
      throw isolationFailure(
        `"${schema}".workflow_status does not exist after DBOS.launch(), so the runtime is still ` +
          `using the default "${DBOS_DEFAULT_SYSTEM_SCHEMA}" schema.`,
      );
    }
    // (3) …and registerQueue wrote into the lane schema too. `queues` is the SDK's
    //     registered-queue table (`workflow_queue` holds ENQUEUED workflows and is
    //     legitimately empty at this point, so it proves nothing here).
    if ((await regclassOf(db, `"${schema}".queues`)) === null) {
      throw isolationFailure(
        `"${schema}".queues does not exist, so DBOS.registerQueue() did not reach the lane schema.`,
      );
    }
    const registered = await countRows(
      db,
      `SELECT count(*)::int AS n FROM "${schema}".queues`,
    );
    if (registered < 1) {
      throw isolationFailure(
        `"${schema}".queues is empty, so this lane registered its queue somewhere else.`,
      );
    }
  });
}

/**
 * POSITIVE proof, enqueuer half. Fold into a spec's FIRST real enqueue assertion — never
 * a synthetic enqueue of a real workflow, which would do real provider/GitHub/S3 work.
 */
export async function assertWorkflowIsolated({
  systemDatabaseUrl,
  schema,
  workflowID,
}: SchemaTarget & { workflowID: string }): Promise<void> {
  assertLaneSchemaName(schema);

  await withSystemDb(systemDatabaseUrl, async (db) => {
    // (4) The ENQUEUER honoured the passthrough. A dropped config would have put this
    //     row in the shared schema instead.
    const mine = await countRows(
      db,
      `SELECT count(*)::int AS n FROM "${schema}".workflow_status WHERE workflow_uuid = $1`,
      workflowID,
    );
    if (mine !== 1) {
      throw isolationFailure(
        `workflow "${workflowID}" has ${mine} row(s) in "${schema}".workflow_status (expected 1), ` +
          `so the enqueuer did not receive systemDatabaseSchemaName.`,
      );
    }

    // (5) …and the shared namespace the container polls never saw this lane's work.
    const sharedExists = await regclassOf(
      db,
      `"${DBOS_DEFAULT_SYSTEM_SCHEMA}".workflow_status`,
    );
    if (sharedExists === null) return;
    const leaked = await countRows(
      db,
      `SELECT count(*)::int AS n FROM "${DBOS_DEFAULT_SYSTEM_SCHEMA}".workflow_status WHERE workflow_uuid = $1`,
      workflowID,
    );
    if (leaked !== 0) {
      throw isolationFailure(
        `workflow "${workflowID}" ALSO appears in the shared "${DBOS_DEFAULT_SYSTEM_SCHEMA}" schema ` +
          `(${leaked} row(s)), which is exactly the namespace the Compose worker polls.`,
      );
    }
  });
}

/**
 * How many workflows named `workflowName` currently exist in this lane's system schema.
 *
 * A WATERMARK PRIMITIVE, for the "exactly one workflow was enqueued" class of assertion.
 * {@link assertWorkflowIsolated} proves that a KNOWN id landed in the lane schema and
 * nowhere else; it counts nothing globally. So a spec that only ever queries ids it already
 * holds is structurally incapable of observing a SECOND workflow appearing under an id it
 * was never told about — which is exactly the defect "exactly one workflow" exists to
 * prevent. Take the count before the act and after it, and assert the DELTA.
 *
 * Reads the lane schema only. A count against the shared `dbos` schema from inside a lane
 * finds zero rows and passes vacuously (preflight §0.2), and `assertLaneSchemaName` makes
 * the interpolation safe for the same reason `resetLaneSchema` relies on it.
 */
export async function countLaneWorkflows({
  systemDatabaseUrl,
  schema,
  workflowName,
}: SchemaTarget & { workflowName: string }): Promise<number> {
  assertLaneSchemaName(schema);

  return withSystemDb(systemDatabaseUrl, async (db) => {
    if ((await regclassOf(db, `"${schema}".workflow_status`)) === null) {
      throw isolationFailure(
        `"${schema}".workflow_status does not exist, so a workflow-count watermark taken here ` +
          `would read 0 forever and every delta assertion over it would pass vacuously.`,
      );
    }
    return countRows(
      db,
      `SELECT count(*)::int AS n FROM "${schema}".workflow_status WHERE name = $1`,
      workflowName,
    );
  });
}
