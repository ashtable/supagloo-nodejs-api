import { describe, it, expect } from "vitest";
import {
  GIT_OPS_QUEUE_NAME,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
  type PrismaClient,
} from "@supagloo/database-lib";
import { ProjectJobsService, type EnqueueOptions } from "./project-jobs-service";
import {
  GitOpsInFlightError,
  ProjectAlreadyExistsError,
  ProjectJobNotFoundError,
  UnsupportedCreatedFromError,
} from "./errors";
import { GithubNotConnectedError } from "../connections/errors";
import { ProjectNotFoundError } from "../projects/errors";

// Unit tests for ProjectJobsService (Task #18, design-delta §5.1/§6b/§7/§8). A FAKE
// Prisma + a recorder `enqueue` + fixed clock/id let us assert, DB-free:
//   - the create path writes Project + ProjectJob(queued, seeded stages) in a txn and
//     enqueues scaffoldProject on git-ops with workflowID = jobId + the exact payload;
//   - the three create-path 409s (no GitHub connection / in-flight git-ops job /
//     already-scaffolded repo) and the import-not-here 400;
//   - the reusable git-ops guard (in-flight → reject, terminal/none → allow);
//   - getJob owner-scoping (foreign/deleted project → 404, wrong-project job → 404).

type Call = { op: string; args: any };

interface FakeConfig {
  connection?: { installationId: string } | null;
  existingProject?: { id: string } | null;
  ownerSlugs?: string[];
  inFlightJobs?: unknown[];
  project?: unknown; // getJob: project.findFirst result
  job?: unknown; // getJob: projectJob.findFirst result
  createdProjectId?: string;
}

function makeFake(config: FakeConfig) {
  const calls: Call[] = [];
  const rec = (op: string, result: unknown) => (args: any) => {
    calls.push({ op, args });
    return Promise.resolve(result);
  };
  const createdProjectId = config.createdProjectId ?? "cprj-new";
  const tx = {
    project: {
      create: (args: any) => {
        calls.push({ op: "project.create", args });
        return Promise.resolve({ id: createdProjectId, ...args.data });
      },
    },
    projectJob: {
      create: (args: any) => {
        calls.push({ op: "projectJob.create", args });
        return Promise.resolve({ ...args.data });
      },
    },
  };
  const prisma = {
    githubConnection: {
      findUnique: rec("githubConnection.findUnique", config.connection ?? null),
    },
    project: {
      findFirst: rec("project.findFirst", config.project ?? config.existingProject ?? null),
      findMany: rec(
        "project.findMany",
        (config.ownerSlugs ?? []).map((slug) => ({ slug })),
      ),
    },
    projectJob: {
      findMany: rec("projectJob.findMany", config.inFlightJobs ?? []),
      findFirst: rec("projectJob.findFirst", config.job ?? null),
    },
    $transaction: (fn: any) => Promise.resolve(fn(tx)),
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

const has = (calls: Call[], op: string) => calls.some((c) => c.op === op);
const find = (calls: Call[], op: string) => calls.find((c) => c.op === op)!;

const CREATE_REQ = {
  name: "Psalm 121",
  repoOwner: "ashtable",
  repoName: "psalm-121",
  visibility: "private" as const,
  createdFrom: "blank" as const,
};

function makeService(
  prisma: PrismaClient,
  enqueueRecorder: { calls: { opts: EnqueueOptions; payload: any }[] },
) {
  return new ProjectJobsService({
    prisma,
    enqueue: async (opts, payload) => {
      enqueueRecorder.calls.push({ opts, payload });
    },
    now: () => new Date("2026-07-19T00:00:00.000Z"),
    generateJobId: () => "job-fixed",
  });
}

describe("ProjectJobsService.createProjectWithScaffold — happy path", () => {
  it("creates Project + queued ProjectJob and enqueues scaffoldProject on git-ops", async () => {
    const { prisma, calls } = makeFake({ connection: { installationId: "42" } });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const svc = makeService(prisma, enqueued);

    const res = await svc.createProjectWithScaffold("u1", CREATE_REQ);

    expect(res).toEqual({ projectId: "cprj-new", jobId: "job-fixed" });

    // Project created with derived slug + pre-scaffold branch.
    const proj = find(calls, "project.create").args.data;
    expect(proj.slug).toBe("psalm-121");
    expect(proj.ownerId).toBe("u1");
    expect(proj.name).toBe("Psalm 121");
    expect(proj.repoOwner).toBe("ashtable");
    expect(proj.repoName).toBe("psalm-121");
    expect(proj.repoVisibility).toBe("private");
    expect(proj.createdFrom).toBe("blank");
    expect(proj.currentBranch).toBe("main");

    // Job created queued, id = generated jobId, with the 8 stages seeded pending.
    const job = find(calls, "projectJob.create").args.data;
    expect(job.id).toBe("job-fixed");
    expect(job.projectId).toBe("cprj-new");
    expect(job.userId).toBe("u1");
    expect(job.kind).toBe("scaffold");
    expect(job.status).toBe("queued");
    expect(Array.isArray(job.stages)).toBe(true);
    expect(job.stages).toHaveLength(8);
    expect(job.stages.every((s: any) => s.state === "pending")).toBe(true);

    // Enqueued AFTER the writes, with workflowID = jobId + the exact payload.
    expect(enqueued.calls).toHaveLength(1);
    expect(enqueued.calls[0].opts).toEqual({
      workflowName: SCAFFOLD_PROJECT_WORKFLOW_NAME,
      queueName: GIT_OPS_QUEUE_NAME,
      workflowID: "job-fixed",
    });
    const payload = enqueued.calls[0].payload;
    expect(payload.projectId).toBe("cprj-new");
    expect(payload.userId).toBe("u1");
    expect(payload.ownerId).toBe("u1");
    expect(payload.installationId).toBe("42");
    expect(payload.repoOwner).toBe("ashtable");
    expect(payload.repoName).toBe("psalm-121");
    expect(payload.repoVisibility).toBe("private");
    expect(payload.createdFrom).toBe("blank");
    expect(payload.slug).toBe("psalm-121");
    expect(payload.name).toBe("Psalm 121");
    expect(payload.manifest.manifestVersion).toBe(1);
    expect(payload.manifest.scenes).toEqual([]);
  });

  it("defaults the project name to the repo name when omitted, and suffixes a taken slug", async () => {
    const { prisma, calls } = makeFake({
      connection: { installationId: "42" },
      ownerSlugs: ["psalm-121"], // base slug taken by a DIFFERENT repo
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const svc = makeService(prisma, enqueued);

    const { name, ...noName } = CREATE_REQ;
    void name;
    await svc.createProjectWithScaffold("u1", noName);

    const proj = find(calls, "project.create").args.data;
    expect(proj.name).toBe("psalm-121"); // defaulted to repo name
    expect(proj.slug).toBe("psalm-121-2"); // suffixed past the taken slug
  });
});

describe("ProjectJobsService.createProjectWithScaffold — rejections", () => {
  it("rejects when the user has no GitHub connection (409, distinct from git-ops)", async () => {
    const { prisma, calls } = makeFake({ connection: null });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectWithScaffold("u1", CREATE_REQ),
    ).rejects.toBeInstanceOf(GithubNotConnectedError);
    expect(has(calls, "project.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("rejects an in-flight git-ops job for the same repo with 409 git_ops_in_flight", async () => {
    const { prisma, calls } = makeFake({
      connection: { installationId: "42" },
      existingProject: { id: "cprj-existing" },
      inFlightJobs: [{ id: "job-old", status: "running" }],
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectWithScaffold("u1", CREATE_REQ),
    ).rejects.toBeInstanceOf(GitOpsInFlightError);
    expect(has(calls, "project.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("rejects a duplicate create for an already-scaffolded repo with 409 project_exists", async () => {
    const { prisma, calls } = makeFake({
      connection: { installationId: "42" },
      existingProject: { id: "cprj-existing" },
      inFlightJobs: [], // only terminal jobs → no in-flight
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectWithScaffold("u1", CREATE_REQ),
    ).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
    expect(has(calls, "project.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("rejects createdFrom=import (uses the task-19 import workflow, not scaffold)", async () => {
    const { prisma } = makeFake({ connection: { installationId: "42" } });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectWithScaffold("u1", {
        ...CREATE_REQ,
        createdFrom: "import",
      }),
    ).rejects.toBeInstanceOf(UnsupportedCreatedFromError);
    expect(enqueued.calls).toHaveLength(0);
  });
});

describe("ProjectJobsService.assertNoInFlightGitOps (reusable guard)", () => {
  it("throws GitOpsInFlightError when a queued or running job exists", async () => {
    const queued = makeFake({ inFlightJobs: [{ id: "j", status: "queued" }] });
    await expect(
      new ProjectJobsService({
        prisma: queued.prisma,
        enqueue: async () => {},
      }).assertNoInFlightGitOps("p1"),
    ).rejects.toBeInstanceOf(GitOpsInFlightError);

    // Query is scoped to the project + the two non-terminal statuses.
    const q = find(queued.calls, "projectJob.findMany").args;
    expect(q.where.projectId).toBe("p1");
    expect(q.where.status).toEqual({ in: ["queued", "running"] });
  });

  it("does not throw when only terminal jobs (or none) exist", async () => {
    for (const inFlightJobs of [[], undefined]) {
      const { prisma } = makeFake({ inFlightJobs });
      await expect(
        new ProjectJobsService({
          prisma,
          enqueue: async () => {},
        }).assertNoInFlightGitOps("p1"),
      ).resolves.toBeUndefined();
    }
  });
});

describe("ProjectJobsService.getJob", () => {
  it("returns the owner-scoped job", async () => {
    const { prisma, calls } = makeFake({
      project: { id: "p1", ownerId: "u1" },
      job: { id: "job-1", projectId: "p1", status: "queued" },
    });
    const res = await new ProjectJobsService({
      prisma,
      enqueue: async () => {},
    }).getJob("u1", "p1", "job-1");
    expect((res as any).id).toBe("job-1");
    // Project resolved with owner + soft-delete scoping.
    expect(find(calls, "project.findFirst").args.where).toEqual({
      id: "p1",
      ownerId: "u1",
      deletedAt: null,
    });
    // Job resolved scoped to the project.
    expect(find(calls, "projectJob.findFirst").args.where).toEqual({
      id: "job-1",
      projectId: "p1",
    });
  });

  it("404s (ProjectNotFoundError) when the project is not visible to the caller", async () => {
    const { prisma } = makeFake({ project: null });
    await expect(
      new ProjectJobsService({ prisma, enqueue: async () => {} }).getJob(
        "u1",
        "p1",
        "job-1",
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("404s (ProjectJobNotFoundError) when the job is missing / on another project", async () => {
    const { prisma } = makeFake({
      project: { id: "p1", ownerId: "u1" },
      job: null,
    });
    await expect(
      new ProjectJobsService({ prisma, enqueue: async () => {} }).getJob(
        "u1",
        "p1",
        "job-x",
      ),
    ).rejects.toBeInstanceOf(ProjectJobNotFoundError);
  });
});
