import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  createPrismaClient,
  type PrismaClient,
  PROJECT_ACTIVE_REPO_UNIQUE_INDEX,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  SCAFFOLD_STAGES,
  buildInitialStages,
  uniqueViolationIndexName,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { ProjectsService } from "../../src/projects/projects-service";
import { ProjectJobsService } from "../../src/jobs/project-jobs-service";
import { makeDbosEnqueuer } from "../../src/jobs/enqueuer";
import {
  assertLaneRuntimeIsolated,
  assertWorkflowIsolated,
  laneSystemSchema,
  resetLaneSchema,
} from "../../src/testing/dbos-lane-isolation";

// Non-UI e2e for the Task #18 job-creation + polling surface (design-delta
// §5.1/§6b/§7/§8). Boots the REAL Fastify app in-process (real listen + fetch), a
// REAL DBOSClient enqueuer, AND a minimal in-process DBOS worker registering a
// STAND-IN `scaffoldProject` on git-ops. The stand-in flips the ProjectJob row
// queued→running→succeeded (barrier-gated) so we deterministically observe every
// state via GET and can hold a job in-flight to fire the 409. This closes the
// enqueue→dispatch→execute→poll loop entirely within the api repo — the REAL scaffold
// workflow's git behaviour is proven separately by the dbos repo's
// scaffold-project.e2e.ts. In-process per the in-flight-dblib constraint (the
// containerized api/dbos can't yet see the uncommitted db-lib exports).
// Infra ensured by tests/e2e/global-setup.ts (reuse-or-spawn postgres+stubs).
//
// ISOLATION, NOT A PRECONDITION. This spec registers a STAND-IN workflow under the REAL
// shared name on the REAL shared queue, so it used to demand an idle Compose `dbos`
// service — a precondition that is unsatisfiable across a full sweep (root's e2e lane
// and nextjs's render lane both bring `dbos` UP and leave it up), and whose stated
// justification here was itself false: root `tests/e2e/global-setup.ts` DOES start that
// service, and did at the time the claim was written. Instead the in-process runtime
// AND the enqueuer share a per-lane DBOS system SCHEMA inside the same `supagloo_dbos`
// database (SDK `systemDatabaseSchemaName`), so the two executors cannot see each other's
// rows in EITHER direction. The container may be up or down; both pass. The queue and
// workflow names are unchanged and deliberately still the real ones — exercising the real
// API↔DBOS name contract is the point of this spec.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const DBOS_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";
/** This lane's private DBOS system schema inside `supagloo_dbos` (see the header note). */
const SYSTEM_SCHEMA = laneSystemSchema("api_jobs");
const YOUVERSION_BASE =
  process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma: PrismaClient = createPrismaClient({ connectionString: APP_URL });

// ---- Barrier controller: park the stand-in worker at chosen phases. ----
let gateA: Promise<void> | null = null;
let releaseA: (() => void) | null = null;
let gateB: Promise<void> | null = null;
let releaseB: (() => void) | null = null;
function armGates(): void {
  gateA = new Promise<void>((r) => (releaseA = r));
  gateB = new Promise<void>((r) => (releaseB = r));
}
function disarmGates(): void {
  gateA = null;
  gateB = null;
}

const runningStages = () =>
  buildInitialStages(SCAFFOLD_STAGES).map((s, i) => ({
    ...s,
    state: i === 0 ? "running" : "pending",
  }));
const doneStages = () =>
  buildInitialStages(SCAFFOLD_STAGES).map((s) => ({ ...s, state: "done" }));

// The stand-in stands in for the real scaffoldProject: it drives the SAME app-DB row
// transitions the real workflow drives (running → stages done → succeeded), keyed by
// workflowID = jobId. `updateMany` no-ops when no row matches (used by the idempotency
// probe, which enqueues a synthetic jobId with no ProjectJob row).
async function standInScaffoldFn(_payload: unknown): Promise<{ ok: true }> {
  const jobId = DBOS.workflowID!;
  if (gateA) await gateA;
  await DBOS.runStep(
    async () => {
      await prisma.projectJob.updateMany({
        where: { id: jobId },
        data: { status: "running", stages: runningStages() as any },
      });
    },
    { name: "standInMarkRunning" },
  );
  if (gateB) await gateB;
  await DBOS.runStep(
    async () => {
      await prisma.projectJob.updateMany({
        where: { id: jobId },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          stages: doneStages() as any,
        },
      });
    },
    { name: "standInFinalize" },
  );
  return { ok: true };
}
DBOS.registerWorkflow(standInScaffoldFn, { name: SCAFFOLD_PROJECT_WORKFLOW_NAME });

let app: FastifyInstance;
let baseUrl: string;
let enqueuer: { enqueue: (o: any, p: unknown) => Promise<void>; close: () => Promise<void> };

beforeAll(async () => {
  // Self-heal a crashed previous run BEFORE launch, so no stale PENDING row is adopted
  // by DBOS's recovery sweep (same executor_id "local", same auto-computed app version).
  await resetLaneSchema({ systemDatabaseUrl: DBOS_URL, schema: SYSTEM_SCHEMA });

  DBOS.setConfig({
    name: "supagloo-api-e2e",
    systemDatabaseUrl: DBOS_URL,
    systemDatabaseSchemaName: SYSTEM_SCHEMA, // ← the runtime half
  });
  await DBOS.launch();
  await DBOS.registerQueue(GIT_OPS_QUEUE_NAME, { workerConcurrency: 4 });

  // Fail FAST and LOUD if the config did not take. Never a warn, never a skip.
  await assertLaneRuntimeIsolated({
    systemDatabaseUrl: DBOS_URL,
    schema: SYSTEM_SCHEMA,
  });

  enqueuer = makeDbosEnqueuer({
    systemDatabaseUrl: DBOS_URL,
    systemDatabaseSchemaName: SYSTEM_SCHEMA, // ← the enqueuer half
  });

  const authService = new AuthService({
    prisma,
    verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
    sessionTtlMs: SESSION_TTL_MS,
  });
  const projectsService = new ProjectsService({ prisma });
  const jobsService = new ProjectJobsService({
    prisma,
    enqueue: enqueuer.enqueue,
  });

  app = buildApp({
    auth: { authService, env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" } },
    projects: { service: projectsService },
    projectJobs: { service: jobsService },
  });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);

afterAll(async () => {
  disarmGates();
  releaseA?.();
  releaseB?.();
  if (app) await app.close();
  await enqueuer?.close().catch(() => {});
  await DBOS.shutdown();
  await prisma.$disconnect().catch(() => {});
});

async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
  const s = stamp();
  const token = `jobs-e2e-${tag}-${s}`;
  const res = await fetch(`${baseUrl}/v1/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      users: [
        {
          youversionUserId: `yv-jobs-${tag}-${s}`,
          displayName: `Jobs E2E ${tag}`,
          email: `jobs-${tag}-${s}@example.test`,
          avatarInitials: "JE",
          sessionToken: token,
        },
      ],
    }),
  });
  const body = await res.json();
  return { token, userId: body.users[0].user.id };
}

async function connectGithub(userId: string, installationId: string): Promise<void> {
  await prisma.githubConnection.create({
    data: {
      userId,
      githubLogin: "ashtable",
      installationId,
      repositorySelection: "all",
      status: "connected",
    },
  });
}

const api = (
  path: string,
  token?: string,
  init: { method?: string; body?: unknown } = {},
) =>
  fetch(`${baseUrl}/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

async function getJob(token: string, projectId: string, jobId: string) {
  const res = await api(`/projects/${projectId}/jobs/${jobId}`, token);
  expect(res.status).toBe(200);
  // The route wraps the DTO in `{ job }` (the `{ project }`/`{ versions }` convention).
  return (await res.json()).job;
}

async function pollUntilStatus(
  token: string,
  projectId: string,
  jobId: string,
  status: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob(token, projectId, jobId);
    if (job.status === status) return job;
    await sleep(150);
  }
  throw new Error(`job ${jobId} did not reach ${status} within ${timeoutMs}ms`);
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error("waitFor timed out");
}

describe("e2e: POST /v1/projects + GET job polling — full round trip", () => {
  it("E-PJ0: the git-ops lane runs on its own DBOS system schema, so the Compose worker cannot see its work", async () => {
    expect(SYSTEM_SCHEMA).not.toBe("dbos");
    await assertLaneRuntimeIsolated({
      systemDatabaseUrl: DBOS_URL,
      schema: SYSTEM_SCHEMA,
    });
  });

  it("creates + enqueues, polls queued→running→succeeded, and blocks concurrent + duplicate creates", async () => {
    armGates();
    const owner = await seedUser("flow");
    await connectGithub(owner.userId, "42");
    const repoName = `psalm-flow-${stamp()}`;
    const createBody = {
      name: "Psalm Flow",
      repoOwner: "ashtable",
      repoName,
      visibility: "private",
      createdFrom: "blank",
    };

    const created = await api("/projects", owner.token, {
      method: "POST",
      body: createBody,
    });
    expect(created.status).toBe(201);
    const { projectId, jobId } = await created.json();
    expect(projectId).toBeTruthy();
    expect(jobId).toBeTruthy();

    // The ENQUEUER half of the isolation is real: the row landed in this lane's schema
    // and is absent from the shared one the Compose worker polls.
    //
    // ORDERING IS LOAD-BEARING — this runs BEFORE the listWorkflows wait below, not
    // after. `POST /projects` awaits the enqueue before it answers 201
    // (project-jobs-service.ts:187), so the row is committed by now and this assertion
    // needs no polling. Placed after the wait, a dropped `systemDatabaseSchemaName` on
    // the enqueuer surfaces as a bare 10 s "waitFor timed out" (measured), which names
    // neither the cause nor the remedy; placed here it fails in milliseconds with both.
    await assertWorkflowIsolated({
      systemDatabaseUrl: DBOS_URL,
      schema: SYSTEM_SCHEMA,
      workflowID: jobId,
    });

    // Durably enqueued in the DBOS system DB under workflowID = jobId (exactly one).
    await waitFor(
      async () => (await DBOS.listWorkflows({ workflowIDs: [jobId] })).length === 1,
      10_000,
    );

    // queued — the worker is parked at gate A, nothing marked yet.
    const queued = await getJob(owner.token, projectId, jobId);
    expect(queued.status).toBe("queued");
    expect(queued.kind).toBe("scaffold");
    expect(queued.stages).toHaveLength(8);
    expect(queued.stages.every((s: any) => s.state === "pending")).toBe(true);

    // release A → running (parked at gate B).
    releaseA!();
    const running = await pollUntilStatus(owner.token, projectId, jobId, "running");
    expect(running.stages.some((s: any) => s.state === "running" || s.state === "done")).toBe(
      true,
    );

    // Concurrent second create for the SAME repo while in-flight → 409 git_ops_in_flight.
    const inFlightDup = await api("/projects", owner.token, {
      method: "POST",
      body: createBody,
    });
    expect(inFlightDup.status).toBe(409);
    expect((await inFlightDup.json()).error).toBe("git_ops_in_flight");

    // release B → succeeded, every stage done.
    releaseB!();
    const done = await pollUntilStatus(owner.token, projectId, jobId, "succeeded");
    expect(done.stages.every((s: any) => s.state === "done")).toBe(true);
    expect(done.completedAt).toBeTruthy();

    // Duplicate create for the same repo AFTER completion → 409 project_exists (no
    // double-create / double-enqueue): still exactly one project + one workflow.
    const terminalDup = await api("/projects", owner.token, {
      method: "POST",
      body: createBody,
    });
    expect(terminalDup.status).toBe(409);
    expect((await terminalDup.json()).error).toBe("project_exists");

    const projectsForRepo = await prisma.project.findMany({
      where: { ownerId: owner.userId, repoOwner: "ashtable", repoName },
    });
    expect(projectsForRepo).toHaveLength(1);
    expect((await DBOS.listWorkflows({ workflowIDs: [jobId] }))).toHaveLength(1);
  }, 60_000);
});

describe("e2e: enqueue idempotency (workflowID dedup)", () => {
  it("enqueuing the same workflowID twice yields exactly one workflow", async () => {
    disarmGates();
    const jobId = `idem-${randomUUID()}`;
    const opts = {
      workflowName: SCAFFOLD_PROJECT_WORKFLOW_NAME,
      queueName: GIT_OPS_QUEUE_NAME,
      workflowID: jobId,
    };
    await enqueuer.enqueue(opts, { note: "idem" });
    await enqueuer.enqueue(opts, { note: "idem" });

    const wfs = await DBOS.listWorkflows({ workflowIDs: [jobId] });
    expect(wfs).toHaveLength(1);
  });
});

describe("e2e: GET job — ownership scoping + auth", () => {
  it("404s a job for a foreign owner or an unknown jobId", async () => {
    disarmGates();
    const owner = await seedUser("nf-owner");
    await connectGithub(owner.userId, "42");
    const other = await seedUser("nf-other");
    const repoName = `psalm-nf-${stamp()}`;

    const created = await api("/projects", owner.token, {
      method: "POST",
      body: {
        repoOwner: "ashtable",
        repoName,
        visibility: "private",
        createdFrom: "blank",
      },
    });
    expect(created.status).toBe(201);
    const { projectId, jobId } = await created.json();

    // Foreign owner → 404 (never leaks existence).
    expect(
      (await api(`/projects/${projectId}/jobs/${jobId}`, other.token)).status,
    ).toBe(404);
    // Unknown job id under the owner's own project → 404.
    expect(
      (await api(`/projects/${projectId}/jobs/does-not-exist`, owner.token)).status,
    ).toBe(404);
  });

  it("401s both routes without a bearer token", async () => {
    expect(
      (
        await api("/projects", undefined, {
          method: "POST",
          body: {
            repoOwner: "a",
            repoName: "b",
            visibility: "private",
            createdFrom: "blank",
          },
        })
      ).status,
    ).toBe(401);
    expect((await api("/projects/x/jobs/y")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------- plan row 49
// Repo-creation race hardening (brief §6). The TOCTOU this closes lives entirely in this
// endpoint: `findFirst`-then-`create` with the check made OUTSIDE the write transaction,
// so two concurrent requests for one repo both passed it. database-lib (6ca5b79) added the
// backing PARTIAL unique index and `project-jobs-service.ts` now maps its `P2002` onto the
// 409 that already existed, instead of letting a raw Prisma error become a 500.
//
// WHY THIS SPEC AND NOT `repo-provisioning.e2e.ts` (a deliberate deviation from the Step-5
// brief §6.4, recorded here so it reads as a decision and not an oversight): `POST
// /v1/projects` makes ZERO GitHub calls — it reads the connection row, dedups, writes two
// rows and enqueues. A real fixture repo would therefore prove nothing about the race while
// costing a durable throwaway repo per run (there is no in-suite teardown, ever) and ~60 s
// of real-host readiness gating. This lane already owns this endpoint, already carries the
// stand-in scaffold worker, and already asserts the two SEQUENTIAL duplicate-create 409s
// immediately above — the concurrent case belongs beside them. The brief's actual
// constraint (never invoke the non-idempotent `createUserRepo` twice) is satisfied by not
// invoking it at all.
describe("e2e: plan row 49 — two SIMULTANEOUS creates for one repo", () => {
  it("E-PJ-R49a: one 201 + one clean 409 (never a 500), one Project, one job, one workflow", async () => {
    disarmGates(); // both requests run to completion; no barrier.
    const owner = await seedUser("race");
    await connectGithub(owner.userId, "42");
    const repoName = `psalm-race-${stamp()}`;
    const createBody = {
      name: "Psalm Race",
      repoOwner: "ashtable",
      repoName,
      visibility: "private",
      createdFrom: "blank",
    };

    // Fired together, awaited together — the two requests interleave on the same event
    // loop, which is exactly the window the application-level `findFirst` cannot see.
    const [a, b] = await Promise.all([
      api("/projects", owner.token, { method: "POST", body: createBody }),
      api("/projects", owner.token, { method: "POST", body: createBody }),
    ]);
    const results = await Promise.all(
      [a, b].map(async (r) => ({ status: r.status, body: await r.json() })),
    );

    const statuses = results.map((r) => r.status).sort();
    // THE HEADLINE ASSERTION. Before the index + the catch, the loser's raw `P2002` had no
    // `statusCode`, so `error-handler.ts` generified it to `500 internal_error`.
    expect(statuses).not.toContain(500);
    expect(statuses).toEqual([201, 409]);

    const won = results.find((r) => r.status === 201)!;
    const lost = results.find((r) => r.status === 409)!;

    // WHICH 409 is not asserted, on purpose. Both guards are correct answers and which one
    // fires is decided by the interleaving: if the winner commits before the loser's
    // `findFirst`, the application check answers `project_exists`; if it commits after,
    // the DB constraint answers (also `project_exists`); and if the winner's job row is
    // already visible, `git_ops_in_flight`. Asserting the MECHANISM would make this test
    // flaky; asserting the INVARIANT — a clean, typed 409 — is the row's actual criterion.
    expect(["project_exists", "git_ops_in_flight"]).toContain(lost.body.error);
    expect(lost.body.message).toBeTruthy();

    // Exactly one Project and exactly one ProjectJob survive — the defect being fixed
    // produced two of each for one GitHub repo.
    const projectsForRepo = await prisma.project.findMany({
      where: { ownerId: owner.userId, repoOwner: "ashtable", repoName },
    });
    expect(projectsForRepo).toHaveLength(1);
    expect(projectsForRepo[0].id).toBe(won.body.projectId);

    const jobsForProject = await prisma.projectJob.findMany({
      where: { projectId: projectsForRepo[0].id },
    });
    expect(jobsForProject).toHaveLength(1);
    expect(jobsForProject[0].id).toBe(won.body.jobId);

    // Exactly one workflow — and read in the LANE schema with ZERO rows in the shared
    // `dbos` schema. A default-schema query from inside a lane finds nothing and would
    // pass vacuously, which is the worst possible failure mode for this assertion.
    await assertWorkflowIsolated({
      systemDatabaseUrl: DBOS_URL,
      schema: SYSTEM_SCHEMA,
      workflowID: won.body.jobId,
    });
    expect(await DBOS.listWorkflows({ workflowIDs: [won.body.jobId] })).toHaveLength(1);
    // The loser enqueued nothing at all: its `jobId` was never issued to a caller, and the
    // winner's is the only git-ops workflow this project ever produced.
    const allForProject = await DBOS.listWorkflows({
      workflowIDs: jobsForProject.map((j) => j.id),
    });
    expect(allForProject).toHaveLength(1);
  }, 60_000);

  it("E-PJ-R49b: the constraint is LIVE in this database and is PARTIAL on deletedAt", async () => {
    disarmGates();
    // The catch under test is only ever exercised if the index actually exists in the
    // database the api is pointed at. Asserting the mapper without asserting the constraint
    // would go green against a database where the migration never ran.
    const owner = await seedUser("index");
    await connectGithub(owner.userId, "42");
    const repoName = `psalm-index-${stamp()}`;
    const created = await api("/projects", owner.token, {
      method: "POST",
      body: {
        repoOwner: "ashtable",
        repoName,
        visibility: "private",
        createdFrom: "blank",
      },
    });
    expect(created.status).toBe(201);
    const { projectId } = await created.json();

    const dupe = {
      slug: `psalm-index-dupe-${stamp()}`, // a FREE slug, so only the repo index can fire
      ownerId: owner.userId,
      name: "Duplicate",
      repoOwner: "ashtable",
      repoName,
      repoVisibility: "private" as const,
      createdFrom: "blank" as const,
      currentBranch: "main",
    };

    const violation = await prisma.project.create({ data: dupe }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(violation).toBeDefined();
    // The name is the cross-repo contract — `meta.target` is absent on this Prisma/adapter
    // pair, so db-lib's extractor is the only thing that recovers it.
    expect(uniqueViolationIndexName(violation)).toBe(PROJECT_ACTIVE_REPO_UNIQUE_INDEX);

    // …and the `WHERE "deletedAt" IS NULL` predicate is real: soft-deleting the project
    // releases the slot, which is what lets a user delete and re-create a project for the
    // same repository. Nothing persisted from the failed insert above.
    await prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });
    const revived = await prisma.project.create({ data: dupe });
    expect(revived.repoName).toBe(repoName);
    await prisma.project.delete({ where: { id: revived.id } });
  }, 60_000);
});
