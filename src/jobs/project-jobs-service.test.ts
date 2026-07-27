import { describe, it, expect } from "vitest";
import {
  COMMIT_VERSION_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  IMPORT_PROJECT_WORKFLOW_NAME,
  PROJECT_ACTIVE_REPO_UNIQUE_INDEX,
  PUBLISH_VERSION_WORKFLOW_NAME,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
  uniqueViolationIndexName,
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
  /**
   * Plan row 49. When set, `$transaction` REJECTS WITHOUT INVOKING THE CALLBACK.
   *
   * That shape is the assertion, not a convenience: a `P2002` raised inside a Prisma
   * interactive transaction aborts it (25P02 — Prisma issues no SAVEPOINT, documented at
   * `gallery-service.ts:542-561`), so a catch sitting INSIDE the callback cannot recover.
   * A fake that only ever throws from within the callback would pass against either shape.
   * Throwing from the transaction CALL passes only if the catch wraps the whole call.
   */
  transactionError?: unknown;
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
    $transaction: (fn: any) => {
      calls.push({ op: "$transaction", args: undefined });
      if ("transactionError" in config) {
        return Promise.reject(config.transactionError);
      }
      return Promise.resolve(fn(tx));
    },
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

type WarnCall = { fields: Record<string, unknown>; message: string };

function makeService(
  prisma: PrismaClient,
  enqueueRecorder: { calls: { opts: EnqueueOptions; payload: any }[] },
  warnRecorder?: WarnCall[],
) {
  return new ProjectJobsService({
    prisma,
    enqueue: async (opts, payload) => {
      enqueueRecorder.calls.push({ opts, payload });
    },
    now: () => new Date("2026-07-19T00:00:00.000Z"),
    generateJobId: () => "job-fixed",
    // Optional in production too (see `ProjectJobsServiceOptions.warn`); every case that
    // omits it is also the assertion that the service still works without a logger.
    warn: warnRecorder
      ? (fields, message) => warnRecorder.push({ fields, message })
      : undefined,
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
  it("REJECTS a structurally-invalid manifest at the boundary (CommitManifestInvalidError, no writes)", async () => {
    // NOTE: TranslationSchema was broadened at task #30 (§9-Q10) from the KJV/BSB enum to
    // any non-empty string, so a translation like "NIV" is now VALID at this boundary. The
    // boundary rejection still fires on a genuinely-invalid manifest — here an EMPTY
    // translation (fails z.string().min(1)).
    const { prisma, calls } = makeFake({
      project: COMMIT_PROJECT,
      connection: { installationId: "42" },
      workingVersion: { semver: "0.0.1" },
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const invalidReq = {
      ...COMMIT_REQ,
      manifest: {
        ...COMMIT_MANIFEST,
        scenes: [{ ...COMMIT_MANIFEST.scenes[0], translation: "" }],
      },
    };
    await expect(
      makeService(prisma, enqueued).createCommitJob("u1", "cprj1", invalidReq as any),
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

// ---------------------------------------------------------------------- plan row 49
// Repo-creation race hardening, api half (brief §6; design-delta §2.6/§8).
//
// THE GAP. "One repo ↔ one project" was enforced only by the `findFirst`-then-`create`
// check above, made OUTSIDE the write transaction and with no DB constraint behind it, so
// two concurrent `POST /v1/projects` for the same repo both passed the check and produced
// two `Project` rows and two `scaffoldProjectWorkflow` runs for one GitHub repo. db-lib
// (6ca5b79) added the backing constraint — a PARTIAL unique index,
// `Project_ownerId_repoOwner_repoName_active_key … WHERE "deletedAt" IS NULL` — and this
// is the half that turns the resulting `P2002` into the 409 that already exists instead of
// the raw Prisma error `error-handler.ts` would generify into a **500**.
//
// TWO MEASURED FACTS SHAPE THE CODE, and both contradict the obvious implementation:
//
//   1. On Prisma 7.8.0 through `@prisma/adapter-pg` — the only client this stack builds —
//      a `P2002` carries NO `meta.target` at all. The violated index name survives only in
//      `err.meta.driverAdapterError.cause.originalMessage`. Every pre-adapter guide says to
//      switch on `meta.target`; code that does reads `undefined`, never matches, and 500s
//      exactly where it meant to 409 — silently, with nothing red. db-lib centralizes the
//      extraction in `uniqueViolationIndexName` so it is not re-derived, and mis-derived,
//      per repo. The fixtures below therefore use the REAL adapter shape.
//
//   2. `Project_ownerId_slug_key` fires FIRST. Postgres checks a row's unique indexes in
//      OID (creation) order, and the slug unique predates this one — measured on the live
//      dev DB: 16616 (slug) vs 69589 (repo). Two simultaneous creates for one repo compute
//      the SAME slug (both run `nextFreeSlug` over the same owned-slug snapshot), so the
//      loser violates BOTH uniques and Postgres reports the slug one:
//
//        ERROR:  duplicate key value violates unique constraint "Project_ownerId_slug_key"
//
//      A different interleaving — the winner commits between the loser's `findFirst` and
//      its `findMany` — yields a different slug and the repo-index violation instead. BOTH
//      names are reachable, which is why the mapping is unconditional over `P2002` (D49.1)
//      rather than narrowed to one index name. A narrowed catch would rethrow the common
//      case and leave the row's own acceptance criterion (a clean 409, not a 500) failing.
describe("plan row 49 — the partial unique index maps to the existing 409", () => {
  /** A `P2002` in the shape `@prisma/adapter-pg` actually produces (measured fact 1). */
  const p2002 = (indexName: string) => ({
    code: "P2002",
    meta: {
      driverAdapterError: {
        cause: {
          originalMessage: `duplicate key value violates unique constraint "${indexName}"`,
        },
      },
    },
  });

  const SLUG_INDEX = "Project_ownerId_slug_key";

  it("U-R49-10: the index name is the cross-repo contract db-lib publishes (D49.2)", () => {
    expect(PROJECT_ACTIVE_REPO_UNIQUE_INDEX).toBe(
      "Project_ownerId_repoOwner_repoName_active_key",
    );
    // WHAT THIS DOES AND DOES NOT COVER — stated precisely, because the earlier wording
    // ("every catch below is matching on a value that no longer arrives") described
    // coverage the api does not have and never wanted. NO catch below matches on a value:
    // `asDuplicateCreate` reads `err.code === "P2002"` and nothing else, deliberately
    // (D49.1 — both `Project_ownerId_slug_key` and the repo index are reachable, so a
    // narrowed catch would rethrow the common case and 500). What this case pins is the
    // CROSS-REPO CONTRACT in two halves:
    //   (a) the index NAME db-lib publishes, so a rename over there is visible over here;
    //   (b) that db-lib's extractor still recovers that name from the measured adapter
    //       shape — which the api now genuinely depends on, because `asDuplicateCreate`
    //       calls `uniqueViolationIndexName(err)` to LOG which unique actually fired
    //       (U-R49-11/12). Before that log line the import was dead and this assertion
    //       proved nothing about api behaviour.
    expect(uniqueViolationIndexName(p2002(PROJECT_ACTIVE_REPO_UNIQUE_INDEX))).toBe(
      PROJECT_ACTIVE_REPO_UNIQUE_INDEX,
    );
    expect(uniqueViolationIndexName(new Error("nope"))).toBeNull();
  });

  it("U-R49-1: create — P2002 on the repo index becomes 409 project_exists, not a 500", async () => {
    const { prisma } = makeFake({
      connection: { installationId: "42" },
      transactionError: p2002(PROJECT_ACTIVE_REPO_UNIQUE_INDEX),
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const err = await makeService(prisma, enqueued)
      .createProjectWithScaffold("u1", CREATE_REQ)
      .then(
        () => undefined,
        (e) => e as Error,
      );
    expect(err).toBeInstanceOf(ProjectAlreadyExistsError);
    // The status is what `error-handler.ts`'s `carriesIntentionalStatus` reads to DELEGATE
    // instead of generifying; a raw Prisma error carries none and becomes a 500.
    expect((err as any).statusCode).toBe(409);
  });

  it("U-R49-2: create — the ANTI-NARROWING guard: the SLUG index is also a 409", async () => {
    // THIS IS THE LOAD-BEARING ONE. It is not "U-R49-1 with a different string" — it is the
    // regression test that fails the moment anyone "tightens" the catch to
    // `isUniqueViolationOn(err, PROJECT_ACTIVE_REPO_UNIQUE_INDEX)`, which reads like an
    // improvement and would 500 on roughly half of all real races (measured: both index
    // names fire non-deterministically on the same test, four runs, Postgres logs).
    const { prisma } = makeFake({
      connection: { installationId: "42" },
      transactionError: p2002(SLUG_INDEX),
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectWithScaffold("u1", CREATE_REQ),
    ).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
  });

  it("U-R49-3: create — a non-P2002 failure is rethrown UNCHANGED, never mistranslated", async () => {
    // Narrowness matters as much as breadth: a raw-query failure answered with
    // "a project already exists for this repository" is a lie the caller cannot debug.
    const other = Object.assign(new Error("Raw query failed"), { code: "P2010" });
    const { prisma } = makeFake({
      connection: { installationId: "42" },
      transactionError: other,
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectWithScaffold("u1", CREATE_REQ),
    ).rejects.toBe(other);
  });

  it("U-R49-4: create — the loser never enqueues a workflow", async () => {
    const { prisma } = makeFake({
      connection: { installationId: "42" },
      transactionError: p2002(PROJECT_ACTIVE_REPO_UNIQUE_INDEX),
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await makeService(prisma, enqueued)
      .createProjectWithScaffold("u1", CREATE_REQ)
      .catch(() => {});
    // "exactly one workflow enqueued" (the row's e2e criterion) is only true if the loser
    // enqueues none. The enqueue is after the transaction, so the throw is what stops it.
    expect(enqueued.calls).toHaveLength(0);
  });

  it("U-R49-8: create — the catch wraps the $transaction CALL, not the callback", async () => {
    const { prisma, calls } = makeFake({
      connection: { installationId: "42" },
      transactionError: p2002(PROJECT_ACTIVE_REPO_UNIQUE_INDEX),
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectWithScaffold("u1", CREATE_REQ),
    ).rejects.toBeInstanceOf(ProjectAlreadyExistsError);
    // The transaction was entered…
    expect(has(calls, "$transaction")).toBe(true);
    // …but the callback never ran, so nothing INSIDE it could have caught this. Passing
    // this while catching inside the callback is impossible.
    expect(has(calls, "project.create")).toBe(false);
  });

  it("U-R49-5: import — P2002 on the repo index becomes 409 project_exists (finding S9)", async () => {
    // The plan row names only `createProjectWithScaffold`, but the identical
    // findFirst-then-create shape lives in the import path too, and the index constrains
    // both. Catching in one place only would trade a duplicate-project bug for a new 500.
    const { prisma } = makeFake({
      connection: { installationId: "42" },
      transactionError: p2002(PROJECT_ACTIVE_REPO_UNIQUE_INDEX),
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const err = await makeService(prisma, enqueued)
      .createProjectFromImport("u1", IMPORT_REQ)
      .then(
        () => undefined,
        (e) => e as Error,
      );
    expect(err).toBeInstanceOf(ProjectAlreadyExistsError);
    expect((err as any).statusCode).toBe(409);
  });

  it("U-R49-6: import — a non-P2002 failure is rethrown unchanged", async () => {
    const other = Object.assign(new Error("connection reset"), { code: "P1017" });
    const { prisma } = makeFake({
      connection: { installationId: "42" },
      transactionError: other,
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await expect(
      makeService(prisma, enqueued).createProjectFromImport("u1", IMPORT_REQ),
    ).rejects.toBe(other);
  });

  it("U-R49-7: import — the loser never enqueues, and never enters the callback", async () => {
    const { prisma, calls } = makeFake({
      connection: { installationId: "42" },
      transactionError: p2002(SLUG_INDEX),
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    await makeService(prisma, enqueued)
      .createProjectFromImport("u1", IMPORT_REQ)
      .catch(() => {});
    expect(enqueued.calls).toHaveLength(0);
    expect(has(calls, "project.create")).toBe(false);
  });

  // ------------------------------------------------------ Step-11 item 27 (R49-2)
  // The unconditional map is correct (D49.1, measured) but it was SILENT, and silence is
  // what makes two different faults indistinguishable:
  //
  //   1. A currently-reachable wrong message. Owner `u` has connections to `alice/my-app`
  //      and `bob/my-app` and fires both creates at once. Both slugify to `my-app`, neither
  //      sees the other's project for its own triple, both derive the SAME slug; the loser
  //      violates `Project_ownerId_slug_key` and is told "a project already exists for this
  //      repository", which is false for `bob/my-app`. (Transient — a retry succeeds — and
  //      still far better than the pre-fix 500, so the 409 stays; only the diagnostic was
  //      missing.)
  //   2. A permanent data fault with no symptom. If `nextFreeSlug` ever regresses and
  //      returns a taken slug, every create for that owner answers a clean 409 forever.
  //      `error-handler.ts` logs only what it generifies into a 500, so this path produced
  //      ZERO log lines and ZERO 500s: a green dashboard over permanently broken creates.
  //
  // One warn line carrying the index name distinguishes them — and it is what finally gives
  // the api a PRODUCTION consumer for db-lib's `uniqueViolationIndexName` (see U-R49-10).
  it("U-R49-11: create — the losing race is LOGGED with the index that actually fired", async () => {
    const { prisma } = makeFake({
      connection: { installationId: "42" },
      transactionError: p2002(SLUG_INDEX),
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const warns: WarnCall[] = [];

    const err = await makeService(prisma, enqueued, warns)
      .createProjectWithScaffold("u1", CREATE_REQ)
      .then(
        () => undefined,
        (e) => e as Error,
      );

    // D49.1's unconditional 409 is UNCHANGED — the log is additive, not a new branch.
    expect(err).toBeInstanceOf(ProjectAlreadyExistsError);
    expect((err as any).statusCode).toBe(409);

    expect(warns).toHaveLength(1);
    // The slug index, not the repo index: the whole point is that the operator can tell
    // which unique fired, because the 409's message is only true for one of them.
    expect(warns[0].fields.index).toBe(SLUG_INDEX);
    expect(warns[0].message).toContain("unique-violation race");
  });

  it("U-R49-12: import logs it too, and a non-P2002 failure logs NOTHING", async () => {
    const { prisma } = makeFake({
      connection: { installationId: "42" },
      transactionError: p2002(PROJECT_ACTIVE_REPO_UNIQUE_INDEX),
    });
    const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
    const warns: WarnCall[] = [];
    await makeService(prisma, enqueued, warns)
      .createProjectFromImport("u1", IMPORT_REQ)
      .catch(() => {});
    expect(warns).toHaveLength(1);
    expect(warns[0].fields.index).toBe(PROJECT_ACTIVE_REPO_UNIQUE_INDEX);

    // Narrowness matters as much as breadth here too: a warn on every transaction failure
    // would train the operator to ignore the line that means "a real unique fired".
    const other = Object.assign(new Error("Raw query failed"), { code: "P2010" });
    const second = makeFake({
      connection: { installationId: "42" },
      transactionError: other,
    });
    const warns2: WarnCall[] = [];
    await makeService(second.prisma, enqueued, warns2)
      .createProjectWithScaffold("u1", CREATE_REQ)
      .catch(() => {});
    expect(warns2).toEqual([]);
  });

  it("U-R49-9: the pre-transaction guard is UNCHANGED — the constraint is a backstop", async () => {
    // The application-level check still answers the common (sequential) cases without ever
    // reaching the database constraint, and still distinguishes the two 409s. The DB
    // constraint only decides the genuinely-concurrent case the check cannot see.
    for (const [inFlightJobs, expected] of [
      [[{ id: "job-old", status: "running" }], GitOpsInFlightError],
      [[], ProjectAlreadyExistsError],
    ] as const) {
      const { prisma, calls } = makeFake({
        connection: { installationId: "42" },
        existingProject: { id: "cprj-existing" },
        inFlightJobs: [...inFlightJobs],
      });
      const enqueued = { calls: [] as { opts: EnqueueOptions; payload: any }[] };
      await expect(
        makeService(prisma, enqueued).createProjectWithScaffold("u1", CREATE_REQ),
      ).rejects.toBeInstanceOf(expected);
      expect(has(calls, "$transaction")).toBe(false);
    }
  });
});
