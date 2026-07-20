import { describe, it, expect } from "vitest";
import {
  COMMIT_VERSION_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  IMPORT_PROJECT_WORKFLOW_NAME,
  PUBLISH_VERSION_WORKFLOW_NAME,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
  type PrismaClient,
} from "@supagloo/database-lib";
import { ProjectJobsService, type EnqueueOptions } from "./project-jobs-service";
import {
  CommitManifestInvalidError,
  GitOpsInFlightError,
  NoWorkingVersionError,
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
  project?: unknown; // getJob / commit: project.findFirst result
  job?: unknown; // getJob: projectJob.findFirst result
  workingVersion?: { semver: string } | null; // commit: projectVersion.findFirst result
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
    projectVersion: {
      findFirst: rec("projectVersion.findFirst", config.workingVersion ?? null),
    },
    projectJob: {
      findMany: rec("projectJob.findMany", config.inFlightJobs ?? []),
      findFirst: rec("projectJob.findFirst", config.job ?? null),
      // Commit creates the ProjectJob directly (no transaction — only one row).
      create: (args: any) => {
        calls.push({ op: "projectJob.create", args });
        return Promise.resolve({ ...args.data });
      },
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

const IMPORT_REQ = {
  name: "Imported Psalm",
  repoOwner: "ashtable",
  repoName: "psalm-121",
  visibility: "private" as const,
};

const COMMIT_MANIFEST = {
  manifestVersion: 1 as const,
  composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
  scenes: [
    {
      id: "s1",
      name: "Shelter",
      scriptText: "He who dwells in the shelter of the Most High.",
      reference: "Psalm 91:1",
      translation: "BSB" as const,
      visualPrompt: "A traveler resting under a vast starlit desert sky",
      durationSeconds: 5,
      captions: true,
    },
  ],
  narratorVoice: { description: "Warm, reverent male narrator" },
};

const COMMIT_REQ = {
  manifest: COMMIT_MANIFEST,
  message: "Tighten the shelter scene pacing",
};

const PUBLISH_REQ = {
  message: "Publish the shelter cut",
};

// The project the commit endpoint resolves for `:id` (owner-scoped, on its working branch).
const COMMIT_PROJECT = {
  id: "cprj1",
  ownerId: "u1",
  repoOwner: "ashtable",
  repoName: "psalm-121",
  currentBranch: "v0.0.1",
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

describe("ProjectJobsService.createProjectFromImport — happy path (Task #19)", () => {
  it("creates Project(createdFrom=import) + import_verify ProjectJob and enqueues importProject", async () => {
    const { prisma, calls } = makeFake({ connection: { installationId: "42" } });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const svc = makeService(prisma, enqueued);

    const res = await svc.createProjectFromImport("u1", IMPORT_REQ);

    expect(res).toEqual({ projectId: "cprj-new", jobId: "job-fixed" });

    // Project created for import (branch left as the repo default until the workflow
    // resolves the imported version branch).
    const proj = find(calls, "project.create").args.data;
    expect(proj.slug).toBe("psalm-121");
    expect(proj.ownerId).toBe("u1");
    expect(proj.name).toBe("Imported Psalm");
    expect(proj.repoOwner).toBe("ashtable");
    expect(proj.repoName).toBe("psalm-121");
    expect(proj.repoVisibility).toBe("private");
    expect(proj.createdFrom).toBe("import");
    expect(proj.currentBranch).toBe("main");

    // Job created queued, kind import_verify, with the 6 import stages seeded pending.
    const job = find(calls, "projectJob.create").args.data;
    expect(job.id).toBe("job-fixed");
    expect(job.projectId).toBe("cprj-new");
    expect(job.userId).toBe("u1");
    expect(job.kind).toBe("import_verify");
    expect(job.status).toBe("queued");
    expect(Array.isArray(job.stages)).toBe(true);
    expect(job.stages).toHaveLength(6);
    expect(job.stages.every((s: any) => s.state === "pending")).toBe(true);

    // Enqueued AFTER the writes, on the import workflow, with the exact payload — and
    // NO manifest / createdFrom (import discovers those from the cloned repo).
    expect(enqueued.calls).toHaveLength(1);
    expect(enqueued.calls[0].opts).toEqual({
      workflowName: IMPORT_PROJECT_WORKFLOW_NAME,
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
    expect(payload.slug).toBe("psalm-121");
    expect(payload.name).toBe("Imported Psalm");
    expect("manifest" in payload).toBe(false);
    expect("createdFrom" in payload).toBe(false);
  });

  it("defaults the project name to the repo name when omitted, and suffixes a taken slug", async () => {
    const { prisma, calls } = makeFake({
      connection: { installationId: "42" },
      ownerSlugs: ["psalm-121"],
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const svc = makeService(prisma, enqueued);

    const { name, ...noName } = IMPORT_REQ;
    void name;
    await svc.createProjectFromImport("u1", noName);

    const proj = find(calls, "project.create").args.data;
    expect(proj.name).toBe("psalm-121");
    expect(proj.slug).toBe("psalm-121-2");
  });
});

describe("ProjectJobsService.createProjectFromImport — rejections (Task #19)", () => {
  it("rejects when the user has no GitHub connection (409, distinct from git-ops)", async () => {
    const { prisma, calls } = makeFake({ connection: null });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectFromImport("u1", IMPORT_REQ),
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
      makeService(prisma, enqueued).createProjectFromImport("u1", IMPORT_REQ),
    ).rejects.toBeInstanceOf(GitOpsInFlightError);
    expect(has(calls, "project.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("rejects a duplicate import for an already-imported repo with 409 project_exists", async () => {
    const { prisma, calls } = makeFake({
      connection: { installationId: "42" },
      existingProject: { id: "cprj-existing" },
      inFlightJobs: [],
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectFromImport("u1", IMPORT_REQ),
    ).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
    expect(has(calls, "project.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });
});

describe("ProjectJobsService.createCommitJob — happy path (Task #21)", () => {
  it("creates a commit ProjectJob and enqueues commitVersion with the exact payload", async () => {
    const { prisma, calls } = makeFake({
      project: COMMIT_PROJECT,
      connection: { installationId: "42" },
      workingVersion: { semver: "0.0.1" },
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const svc = makeService(prisma, enqueued);

    const res = await svc.createCommitJob("u1", "cprj1", COMMIT_REQ);

    expect(res).toEqual({ jobId: "job-fixed" });

    // The project is resolved owner-scoped + soft-delete aware.
    expect(find(calls, "project.findFirst").args.where).toEqual({
      id: "cprj1",
      ownerId: "u1",
      deletedAt: null,
    });

    // Job created queued, kind commit, with the 5 commit stages seeded pending.
    const job = find(calls, "projectJob.create").args.data;
    expect(job.id).toBe("job-fixed");
    expect(job.projectId).toBe("cprj1");
    expect(job.userId).toBe("u1");
    expect(job.kind).toBe("commit");
    expect(job.status).toBe("queued");
    expect(Array.isArray(job.stages)).toBe(true);
    expect(job.stages).toHaveLength(5);
    expect(job.stages.every((s: any) => s.state === "pending")).toBe(true);

    // Enqueued AFTER the write, on the commit workflow, with the exact payload — carrying
    // the edited manifest, the message, the working branch, and the working version semver.
    expect(enqueued.calls).toHaveLength(1);
    expect(enqueued.calls[0].opts).toEqual({
      workflowName: COMMIT_VERSION_WORKFLOW_NAME,
      queueName: GIT_OPS_QUEUE_NAME,
      workflowID: "job-fixed",
    });
    const payload = enqueued.calls[0].payload;
    expect(payload.projectId).toBe("cprj1");
    expect(payload.userId).toBe("u1");
    expect(payload.installationId).toBe("42");
    expect(payload.repoOwner).toBe("ashtable");
    expect(payload.repoName).toBe("psalm-121");
    expect(payload.branchName).toBe("v0.0.1");
    expect(payload.semver).toBe("0.0.1");
    expect(payload.message).toBe("Tighten the shelter scene pacing");
    expect(payload.manifest.manifestVersion).toBe(1);
    expect(payload.manifest.scenes[0].name).toBe("Shelter");
  });
});

describe("ProjectJobsService.createCommitJob — rejections (Task #21)", () => {
  it("REJECTS a non-KJV/BSB manifest at the boundary (CommitManifestInvalidError, no writes)", async () => {
    const { prisma, calls } = makeFake({
      project: COMMIT_PROJECT,
      connection: { installationId: "42" },
      workingVersion: { semver: "0.0.1" },
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const nivReq = {
      ...COMMIT_REQ,
      manifest: {
        ...COMMIT_MANIFEST,
        scenes: [{ ...COMMIT_MANIFEST.scenes[0], translation: "NIV" }],
      },
    };
    await expect(
      makeService(prisma, enqueued).createCommitJob("u1", "cprj1", nivReq as any),
    ).rejects.toBeInstanceOf(CommitManifestInvalidError);
    expect(has(calls, "projectJob.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("404s (ProjectNotFoundError) an unknown / foreign / deleted project", async () => {
    const { prisma, calls } = makeFake({ project: null });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createCommitJob("u1", "nope", COMMIT_REQ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(has(calls, "projectJob.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("409s (GithubNotConnectedError) when the owner has no GitHub connection", async () => {
    const { prisma, calls } = makeFake({ project: COMMIT_PROJECT, connection: null });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createCommitJob("u1", "cprj1", COMMIT_REQ),
    ).rejects.toBeInstanceOf(GithubNotConnectedError);
    expect(has(calls, "projectJob.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("409s (NoWorkingVersionError) when the project has no working version on its branch", async () => {
    const { prisma, calls } = makeFake({
      project: COMMIT_PROJECT,
      connection: { installationId: "42" },
      workingVersion: null,
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createCommitJob("u1", "cprj1", COMMIT_REQ),
    ).rejects.toBeInstanceOf(NoWorkingVersionError);
    expect(has(calls, "projectJob.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("409s (GitOpsInFlightError) when a git-ops job is already in flight", async () => {
    const { prisma, calls } = makeFake({
      project: COMMIT_PROJECT,
      connection: { installationId: "42" },
      workingVersion: { semver: "0.0.1" },
      inFlightJobs: [{ id: "job-old", status: "running" }],
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createCommitJob("u1", "cprj1", COMMIT_REQ),
    ).rejects.toBeInstanceOf(GitOpsInFlightError);
    expect(has(calls, "projectJob.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });
});

describe("ProjectJobsService.createPublishJob — happy path (Task #22)", () => {
  it("creates a publish ProjectJob and enqueues publishVersion with the exact payload (no manifest)", async () => {
    const { prisma, calls } = makeFake({
      project: COMMIT_PROJECT,
      connection: { installationId: "42" },
      workingVersion: { semver: "0.0.1" },
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const svc = makeService(prisma, enqueued);

    const res = await svc.createPublishJob("u1", "cprj1", PUBLISH_REQ);

    expect(res).toEqual({ jobId: "job-fixed" });

    // The project is resolved owner-scoped + soft-delete aware.
    expect(find(calls, "project.findFirst").args.where).toEqual({
      id: "cprj1",
      ownerId: "u1",
      deletedAt: null,
    });

    // Job created queued, kind publish, with the 7 publish stages seeded pending.
    const job = find(calls, "projectJob.create").args.data;
    expect(job.id).toBe("job-fixed");
    expect(job.projectId).toBe("cprj1");
    expect(job.userId).toBe("u1");
    expect(job.kind).toBe("publish");
    expect(job.status).toBe("queued");
    expect(Array.isArray(job.stages)).toBe(true);
    expect(job.stages).toHaveLength(7);
    expect(job.stages.every((s: any) => s.state === "pending")).toBe(true);

    // Enqueued AFTER the write, on the publish workflow, with the exact payload — carrying
    // the working branch + the working version semver + the message, and NO manifest.
    expect(enqueued.calls).toHaveLength(1);
    expect(enqueued.calls[0].opts).toEqual({
      workflowName: PUBLISH_VERSION_WORKFLOW_NAME,
      queueName: GIT_OPS_QUEUE_NAME,
      workflowID: "job-fixed",
    });
    const payload = enqueued.calls[0].payload;
    expect(payload.projectId).toBe("cprj1");
    expect(payload.userId).toBe("u1");
    expect(payload.installationId).toBe("42");
    expect(payload.repoOwner).toBe("ashtable");
    expect(payload.repoName).toBe("psalm-121");
    expect(payload.branchName).toBe("v0.0.1");
    expect(payload.semver).toBe("0.0.1");
    expect(payload.message).toBe("Publish the shelter cut");
    expect("manifest" in payload).toBe(false);
  });
});

describe("ProjectJobsService.createPublishJob — rejections (Task #22)", () => {
  it("404s (ProjectNotFoundError) an unknown / foreign / deleted project", async () => {
    const { prisma, calls } = makeFake({ project: null });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createPublishJob("u1", "nope", PUBLISH_REQ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(has(calls, "projectJob.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("409s (GithubNotConnectedError) when the owner has no GitHub connection", async () => {
    const { prisma, calls } = makeFake({ project: COMMIT_PROJECT, connection: null });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createPublishJob("u1", "cprj1", PUBLISH_REQ),
    ).rejects.toBeInstanceOf(GithubNotConnectedError);
    expect(has(calls, "projectJob.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("409s (NoWorkingVersionError) when the project has no working version on its branch", async () => {
    const { prisma, calls } = makeFake({
      project: COMMIT_PROJECT,
      connection: { installationId: "42" },
      workingVersion: null,
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createPublishJob("u1", "cprj1", PUBLISH_REQ),
    ).rejects.toBeInstanceOf(NoWorkingVersionError);
    expect(has(calls, "projectJob.create")).toBe(false);
    expect(enqueued.calls).toHaveLength(0);
  });

  it("409s (GitOpsInFlightError) when a git-ops job is already in flight", async () => {
    const { prisma, calls } = makeFake({
      project: COMMIT_PROJECT,
      connection: { installationId: "42" },
      workingVersion: { semver: "0.0.1" },
      inFlightJobs: [{ id: "job-old", status: "running" }],
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createPublishJob("u1", "cprj1", PUBLISH_REQ),
    ).rejects.toBeInstanceOf(GitOpsInFlightError);
    expect(has(calls, "projectJob.create")).toBe(false);
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
