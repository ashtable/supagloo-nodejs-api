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

export function makeDbosEnqueuer(config: {
  systemDatabaseUrl: string;
}): JobEnqueuer {
  let clientPromise: Promise<DBOSClient> | undefined;
  const getClient = () => {
    if (!clientPromise) {
      clientPromise = DBOSClient.create({
        systemDatabaseUrl: config.systemDatabaseUrl,
      });
    }
    return clientPromise;
  };

  return {
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
