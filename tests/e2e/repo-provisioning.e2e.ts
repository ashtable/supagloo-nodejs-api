import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { makeGithubUserAuthClient } from "../../src/connections/github-user-auth-client";
import { RepoProvisioningService } from "../../src/projects/repo-provisioning-service";

// Non-UI e2e for the Task #26 create-new-repo JIT hop (design-delta §2.3/§6b/§8).
// Boots the REAL Fastify app in-process (real listen + fetch) with the REAL
// user-auth client pointed at the containerized github-stub (host port 4801, which
// serves BOTH the OAuth host `/login/oauth/access_token` and the API host
// `/user/repos` + `PUT /user/installations/:id/repositories/:repoId`), a REAL
// DBOSClient enqueuer, AND the SAME stand-in `scaffoldProject` worker the task-18
// e2e uses (so the delegated create job advances queued→running→succeeded).
//
// The github-stub has NO counter-reset/introspection route, and it accumulates state
// across a shared container, so this e2e asserts through the API's OWN observable
// effects (201 body, created Project row, job status) with UNIQUE stamped repo names
// — never exact stub counters. In-process per the in-flight-dblib constraint.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const DBOS_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";
const YOUVERSION_BASE =
  process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";
const GITHUB_BASE = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma: PrismaClient = createPrismaClient({ connectionString: APP_URL });

const doneStages = () =>
  buildInitialStages(SCAFFOLD_STAGES).map((s) => ({ ...s, state: "done" }));

// Stand-in scaffold worker: drive the app-DB row to succeeded (keyed by workflowID =
// jobId). No gates — the JIT e2e just needs the delegated create job to complete.
async function standInScaffoldFn(_payload: unknown): Promise<{ ok: true }> {
  const jobId = DBOS.workflowID!;
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
let enqueuer: {
  enqueue: (o: any, p: unknown) => Promise<void>;
  close: () => Promise<void>;
};

beforeAll(async () => {
  DBOS.setConfig({ name: "supagloo-api-repo-prov-e2e", systemDatabaseUrl: DBOS_URL });
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
  const userAuthClient = makeGithubUserAuthClient({
    oauthBaseUrl: GITHUB_BASE,
    apiBaseUrl: GITHUB_BASE,
    clientId: "Iv1.stubclient",
    clientSecret: "stubsecret",
  });
  const repoProvisioningService = new RepoProvisioningService({
    prisma,
    userAuthClient,
    createProject: (userId, req) =>
      jobsService.createProjectWithScaffold(userId, req),
  });

  app = buildApp({
    auth: {
      authService,
      env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
    },
    projects: { service: projectsService },
    projectJobs: { service: jobsService },
    repoProvisioning: { service: repoProvisioningService },
  });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  await enqueuer?.close().catch(() => {});
  await DBOS.shutdown();
  await prisma.$disconnect().catch(() => {});
});

async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
  const s = stamp();
  const token = `repoprov-e2e-${tag}-${s}`;
  const res = await fetch(`${baseUrl}/v1/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      users: [
        {
          youversionUserId: `yv-repoprov-${tag}-${s}`,
          displayName: `RepoProv E2E ${tag}`,
          email: `repoprov-${tag}-${s}@example.test`,
          avatarInitials: "RP",
          sessionToken: token,
        },
      ],
    }),
  });
  const body = await res.json();
  return { token, userId: body.users[0].user.id };
}

async function connectGithub(
  userId: string,
  installationId: string,
  repositorySelection = "selected",
): Promise<void> {
  await prisma.githubConnection.create({
    data: {
      userId,
      githubLogin: "acme",
      installationId,
      repositorySelection,
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

async function pollUntilStatus(
  token: string,
  projectId: string,
  jobId: string,
  status: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(`/projects/${projectId}/jobs/${jobId}`, token);
    if (res.status === 200) {
      const { job } = await res.json();
      if (job.status === status) return job;
    }
    await sleep(150);
  }
  throw new Error(`job ${jobId} did not reach ${status} within ${timeoutMs}ms`);
}

describe("e2e: GET /v1/projects/repo-authorize-url", () => {
  it("returns the GitHub user-authorization URL with client_id, redirect_uri, scope, state", async () => {
    const owner = await seedUser("authurl");
    const redirectUri = "http://localhost:3000/connect/github/create-repo/callback";
    const res = await api(
      `/projects/repo-authorize-url?redirectUri=${encodeURIComponent(redirectUri)}&state=nonce-xyz`,
      owner.token,
    );
    expect(res.status).toBe(200);
    const { url } = await res.json();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${GITHUB_BASE}/login/oauth/authorize`);
    expect(parsed.searchParams.get("client_id")).toBe("Iv1.stubclient");
    expect(parsed.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(parsed.searchParams.get("scope")).toBe("repo");
    expect(parsed.searchParams.get("state")).toBe("nonce-xyz");
  });

  it("401s without a bearer token", async () => {
    expect(
      (await api("/projects/repo-authorize-url?redirectUri=http://x&state=y")).status,
    ).toBe(401);
  });
});

describe("e2e: POST /v1/projects/create-repo — the JIT hop → scaffold", () => {
  it("exchanges the code, creates the repo, and scaffolds it to succeeded", async () => {
    const owner = await seedUser("create");
    await connectGithub(owner.userId, "42", "selected");
    const repoName = `psalm-jit-${stamp()}`;

    const created = await api("/projects/create-repo", owner.token, {
      method: "POST",
      body: {
        code: "gh-user-auth-code",
        name: "Psalm JIT",
        repoName,
        visibility: "private",
        createdFrom: "blank",
      },
    });
    expect(created.status).toBe(201);
    const { projectId, jobId } = await created.json();
    expect(projectId).toBeTruthy();
    expect(jobId).toBeTruthy();

    // The created Project points at the GitHub-assigned owner ("acme" from the stub)
    // and the requested repo name — proving the repo was created via the user token,
    // not supplied by the client.
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.repoOwner).toBe("acme");
    expect(project?.repoName).toBe(repoName);
    expect(project?.createdFrom).toBe("blank");

    // The delegated scaffold job runs to completion (stand-in worker).
    const done = await pollUntilStatus(owner.token, projectId, jobId, "succeeded");
    expect(done.stages.every((s: any) => s.state === "done")).toBe(true);
  }, 60_000);

  it("409 github_not_connected when the user has no GitHub connection", async () => {
    const owner = await seedUser("noconn");
    const res = await api("/projects/create-repo", owner.token, {
      method: "POST",
      body: {
        code: "gh-user-auth-code",
        repoName: `psalm-noconn-${stamp()}`,
        visibility: "private",
        createdFrom: "blank",
      },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("github_not_connected");
  });

  it("401s without a bearer token", async () => {
    expect(
      (
        await api("/projects/create-repo", undefined, {
          method: "POST",
          body: {
            code: "c",
            repoName: "r",
            visibility: "private",
            createdFrom: "blank",
          },
        })
      ).status,
    ).toBe(401);
  });
});
