import { describe, expect, it, vi } from "vitest";
import { makeDbosEnqueuer, type DbosEnqueuerConfig } from "./enqueuer";

// Unit cover for the production DBOS enqueuer. The `createClient` seam is the repo's
// house style (injected seams, not module mocks — cf. GalleryService/ProjectJobsService),
// so nothing here opens a system-DB connection.

const SYS_URL = "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";

interface FakeClient {
  enqueue: ReturnType<typeof vi.fn>;
  cancelWorkflow: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<DbosEnqueuerConfig> = {}) {
  const created: Array<{
    systemDatabaseUrl: string;
    systemDatabaseSchemaName?: string;
  }> = [];
  const clients: FakeClient[] = [];
  const createClient = vi.fn(async (opts: {
    systemDatabaseUrl: string;
    systemDatabaseSchemaName?: string;
  }) => {
    created.push(opts);
    const client: FakeClient = {
      enqueue: vi.fn(async () => undefined),
      cancelWorkflow: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    };
    clients.push(client);
    return client as never;
  });

  const enqueuer = makeDbosEnqueuer({
    systemDatabaseUrl: SYS_URL,
    createClient,
    ...overrides,
  });
  return { enqueuer, createClient, created, clients };
}

describe("makeDbosEnqueuer", () => {
  it("U-EQ1: passes systemDatabaseUrl straight through to DBOSClient.create", async () => {
    const { enqueuer, created } = harness();
    await enqueuer.enqueue(
      { workflowName: "wf", queueName: "q", workflowID: "id-1" },
      { a: 1 },
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.systemDatabaseUrl).toBe(SYS_URL);
  });

  it("U-EQ2: passes systemDatabaseSchemaName through when supplied", async () => {
    const { enqueuer, created } = harness({
      systemDatabaseSchemaName: "dbos_e2e_api_render",
    });
    await enqueuer.enqueue(
      { workflowName: "wf", queueName: "q", workflowID: "id-1" },
      {},
    );
    expect(created[0]!.systemDatabaseSchemaName).toBe("dbos_e2e_api_render");
  });

  it('U-EQ3: sends NO systemDatabaseSchemaName when unset, so the SDK default "dbos" stands', async () => {
    const { enqueuer, created } = harness();
    await enqueuer.enqueue(
      { workflowName: "wf", queueName: "q", workflowID: "id-1" },
      {},
    );
    // The pin that PRODUCTION behaviour is byte-identical: the SDK's SystemDatabase
    // constructor uses a JS default parameter (`schemaName = 'dbos'`), so an explicit
    // `undefined` IS the default — but a stray "" or "dbos_e2e_…" would not be.
    expect(created[0]!.systemDatabaseSchemaName).toBeUndefined();
  });

  it("U-EQ4: creates the client LAZILY and exactly once, reused across enqueue and cancel", async () => {
    const { enqueuer, createClient } = harness();
    expect(createClient).toHaveBeenCalledTimes(0);

    await enqueuer.enqueue(
      { workflowName: "wf", queueName: "q", workflowID: "id-1" },
      {},
    );
    await enqueuer.cancel("id-1");
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("U-EQ5: enqueue forwards exactly { workflowName, queueName, workflowID } + the payload, and NEVER an appVersion", async () => {
    const { enqueuer, clients } = harness();
    const payload = { projectId: "p1" };
    await enqueuer.enqueue(
      { workflowName: "scaffoldProject", queueName: "git-ops", workflowID: "job-9" },
      payload,
    );

    const call = clients[0]!.enqueue.mock.calls[0]!;
    expect(call[0]).toEqual({
      workflowName: "scaffoldProject",
      queueName: "git-ops",
      workflowID: "job-9",
    });
    expect(call[1]).toBe(payload);
    // Change-detector, deliberately. A version-pinned enqueue would close only ONE
    // direction of the executor race: the SDK dequeue predicate is
    // `(application_version IS NULL OR application_version = $3)`, so a pinned stand-in
    // would still steal NULL-versioned REAL enqueues. Per-lane SCHEMA isolation is the
    // fix; appVersion is not.
    expect(Object.keys(call[0] as object).sort()).toEqual([
      "queueName",
      "workflowID",
      "workflowName",
    ]);
  });

  it("U-EQ6: close() destroys the client, and a later enqueue creates a fresh one", async () => {
    const { enqueuer, createClient, clients } = harness();
    await enqueuer.enqueue(
      { workflowName: "wf", queueName: "q", workflowID: "id-1" },
      {},
    );
    await enqueuer.close();
    expect(clients[0]!.destroy).toHaveBeenCalledTimes(1);

    await enqueuer.enqueue(
      { workflowName: "wf", queueName: "q", workflowID: "id-2" },
      {},
    );
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("U-EQ7: a rejected client creation does not poison close()", async () => {
    const createClient = vi.fn(async () => {
      throw new Error("system db unreachable");
    });
    const enqueuer = makeDbosEnqueuer({
      systemDatabaseUrl: SYS_URL,
      createClient: createClient as never,
    });

    await expect(
      enqueuer.enqueue(
        { workflowName: "wf", queueName: "q", workflowID: "id-1" },
        {},
      ),
    ).rejects.toThrow(/system db unreachable/);

    await expect(enqueuer.close()).resolves.toBeUndefined();
  });
});
