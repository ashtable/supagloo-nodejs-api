import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  createPrismaClient,
  type PrismaClient,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  SCAFFOLD_STAGES,
  buildInitialStages,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { ProjectsService } from "../../src/projects/projects-service";
import { ProjectJobsService } from "../../src/jobs/project-jobs-service";
import { makeDbosEnqueuer } from "../../src/jobs/enqueuer";

// Non-UI e2e for the Task #18 job-creation + polling surface (design-delta
// §5.1/§6b/§7/§8). Boots the REAL Fastify app in-process (real listen + fetch), a
// REAL DBOSClient enqueuer, AND a minimal in-process DBOS worker registering a
// STAND-IN `scaffoldProject` on git-ops. The stand-in flips the ProjectJob row
// queued→running→succeeded (barrier-gated) so we deterministically observe every
// state via GET and can hold a job in-flight to fire the 409. This closes the
// enqueue→dispatch→execute→poll loop entirely within the api repo — the REAL scaffold
// workflow's git behaviour is proven separately by the dbos repo's
// scaffold-project.e2e.ts. In-process per the in-flight-dblib constraint (the
// containerized api/dbos can't yet see the uncommitted db-lib exports). Assumes the
// root Compose `dbos` container is NOT running (global-setup never starts it), so
// there is no competing git-ops worker — the same assumption the dbos repo's e2e
// makes. Infra ensured by tests/e2e/global-setup.ts (reuse-or-spawn postgres+stubs).

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const DBOS_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";
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
  DBOS.setConfig({ name: "supagloo-api-e2e", systemDatabaseUrl: DBOS_URL });
  await DBOS.launch();
  await DBOS.registerQueue(GIT_OPS_QUEUE_NAME, { workerConcurrency: 4 });

  enqueuer = makeDbosEnqueuer({ systemDatabaseUrl: DBOS_URL });

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
