import { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { EnqueueOptions, JobEnqueue } from "./project-jobs-service";

/**
 * The production job enqueuer (design-delta §5.1). The API does NOT run the DBOS
 * runtime — it submits work with `DBOSClient` (enqueue-only) against the DBOS SYSTEM
 * database (`supagloo_dbos`). `workflowID` is the domain-record id (the ProjectJob id),
 * so a re-enqueue of the same id is idempotent (DBOS attaches to the existing
 * workflow, never double-runs).
 *
 * The client is created lazily on first enqueue (so `buildApp` wiring never opens a
 * system-DB connection at import time) and reused thereafter. `close()` destroys it.
 */
export interface JobEnqueuer {
  enqueue: JobEnqueue;
  /** Cancel a running/queued workflow by id (`DBOSClient.cancelWorkflow`). Backs the AI
   *  generation cancel endpoint (Task #31); structurally the AiGenerationsService's
   *  injected cancel seam. */
  cancel: (workflowID: string) => Promise<void>;
  close: () => Promise<void>;
}

/** The subset of `DBOSClient` this module actually uses. Narrowing it is what lets the
 *  unit lane inject a recorder without a module mock (the repo's house style). */
export type EnqueuerClient = Pick<
  DBOSClient,
  "enqueue" | "cancelWorkflow" | "destroy"
>;

export interface DbosEnqueuerConfig {
  systemDatabaseUrl: string;
  /**
   * OPTIONAL DBOS system-database SCHEMA. Mirrors the SDK's own
   * `DBOSClient.create({ systemDatabaseSchemaName })`, whose default is `"dbos"`.
   *
   * This is NOT a test hook. It is a production configuration key that implements an
   * already-designed deployment shape: where the platform exposes only ONE database,
   * DBOS's schema-level isolation inside that database is the designed fallback for the
   * two-logical-database topology. It is read by production code from production env
   * (`DBOS_SYSTEM_DATABASE_SCHEMA`), exactly like `DBOS_DATABASE_URL`, and it is unset
   * everywhere in Compose — so today's shipped behaviour is byte-identical to before
   * (pinned by `U-EQ3` and `U-ENV-DS1`).
   *
   * The e2e specs also pass it, EXPLICITLY at the call site, to give each lane its own
   * system schema so the containerised worker and an in-process stand-in cannot race.
   * No spec reads the env var; nothing switches on being "in test".
   */
  systemDatabaseSchemaName?: string;
  /** Injected only by the unit lane; defaults to the real `DBOSClient.create`. */
  createClient?: (opts: {
    systemDatabaseUrl: string;
    systemDatabaseSchemaName?: string;
  }) => Promise<EnqueuerClient>;
}

export function makeDbosEnqueuer(config: DbosEnqueuerConfig): JobEnqueuer {
  const createClient =
    config.createClient ??
    ((opts) => DBOSClient.create(opts) as Promise<EnqueuerClient>);

  let clientPromise: Promise<EnqueuerClient> | undefined;
  const getClient = () => {
    if (!clientPromise) {
      // `systemDatabaseSchemaName` is forwarded as-is. The SDK's SystemDatabase
      // constructor uses a JS default parameter (`schemaName = 'dbos'`), so passing an
      // explicit `undefined` IS the default — there is nothing to branch on.
      clientPromise = createClient({
        systemDatabaseUrl: config.systemDatabaseUrl,
        systemDatabaseSchemaName: config.systemDatabaseSchemaName,
      });
    }
    return clientPromise;
  };

  return {
    // Deliberately NO `appVersion`: the SDK's dequeue predicate is
    // `(application_version IS NULL OR application_version = $3)`, so pinning a version
    // on the enqueue side would close only ONE direction of an executor race while
    // leaving version-pinned workers free to steal NULL-versioned rows. Per-lane SCHEMA
    // isolation closes both directions; `U-EQ5` pins this shape.
    enqueue: async (opts: EnqueueOptions, payload: unknown) => {
      const client = await getClient();
      await client.enqueue(
        {
          workflowName: opts.workflowName,
          queueName: opts.queueName,
          workflowID: opts.workflowID,
        },
        payload,
      );
    },
    cancel: async (workflowID: string) => {
      const client = await getClient();
      await client.cancelWorkflow(workflowID);
    },
    close: async () => {
      if (!clientPromise) return;
      const client = await clientPromise.catch(() => undefined);
      clientPromise = undefined;
      if (client) await client.destroy();
    },
  };
}
