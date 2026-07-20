import { describe, it, expect, vi } from "vitest";
import type { Project } from "@supagloo/database-lib";
import { ManifestService, MANIFEST_FILE } from "./manifest-service";
import { ManifestInvalidError, ManifestNotFoundError } from "./errors";
import { GithubNotConnectedError } from "../connections/errors";
import { ProjectNotFoundError } from "../projects/errors";

// Unit tests for the Task #20 ManifestService (design-delta §5.3/§8). Pure
// orchestration over three injected seams — `getProject` (owner-scoped 404 gate,
// from ProjectsService), a fake Prisma (only `githubConnection.findUnique`), and a
// recorder `getFileContents` (the github contents-client method) — so every branch
// of the resolve → connect → fetch → decode → parse → validate pipeline is tested
// with no DB and no network.

const VALID_MANIFEST = {
  manifestVersion: 1 as const,
  composition: { width: 1080, height: 1920, fps: 30, aspectRatio: "9:16" },
  scenes: [],
  narratorVoice: { description: "Calm, measured narrator" },
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    slug: "psalms",
    ownerId: "user-1",
    name: "Psalms",
    repoOwner: "acme",
    repoName: "psalms-video",
    repoVisibility: "private",
    createdFrom: "blank",
    currentBranch: "v0.0.1",
    thumbnailAssetKey: null,
    lastRenderJobId: null,
    lastOpenedAt: new Date(),
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as Project;
}

/** A fake Prisma exposing only the one method ManifestService uses. */
function fakePrisma(connection: { installationId: string } | null) {
  return {
    githubConnection: {
      findUnique: vi.fn(async () => connection),
    },
  } as never;
}

interface FileContents {
  content: string;
  sha: string;
  path: string;
}

function makeService(opts: {
  proj?: Project;
  getProjectErr?: Error;
  connection?: { installationId: string } | null;
  file?: FileContents | null;
}) {
  const getProject = vi.fn(async () => {
    if (opts.getProjectErr) throw opts.getProjectErr;
    return opts.proj ?? project();
  });
  const getFileContents = vi.fn(async () =>
    opts.file === undefined ? null : opts.file,
  );
  const service = new ManifestService({
    getProject,
    prisma: fakePrisma(
      opts.connection === undefined ? { installationId: "42" } : opts.connection,
    ),
    getFileContents,
  });
  return { service, getProject, getFileContents };
}

const fileOf = (raw: string): FileContents => ({
  content: raw,
  sha: "sha1",
  path: MANIFEST_FILE,
});

describe("ManifestService.readManifest", () => {
  it("resolves, fetches, decodes, and returns the Zod-parsed manifest", async () => {
    const { service, getFileContents } = makeService({
      file: fileOf(JSON.stringify(VALID_MANIFEST)),
    });

    const manifest = await service.readManifest("user-1", "proj-1");

    expect(manifest).toEqual(VALID_MANIFEST);
    // Fetches the manifest file for the project's repo, defaulting ref to currentBranch.
    expect(getFileContents).toHaveBeenCalledWith({
      installationId: "42",
      owner: "acme",
      repo: "psalms-video",
      path: MANIFEST_FILE,
      ref: "v0.0.1",
    });
  });

  it("passes an explicit ref through instead of the current branch", async () => {
    const { service, getFileContents } = makeService({
      file: fileOf(JSON.stringify(VALID_MANIFEST)),
    });

    await service.readManifest("user-1", "proj-1", "v0.0.2");

    expect(getFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "v0.0.2" }),
    );
  });

  it("throws ManifestNotFoundError (404) when the file is absent", async () => {
    const { service } = makeService({ file: null });
    await expect(service.readManifest("user-1", "proj-1")).rejects.toBeInstanceOf(
      ManifestNotFoundError,
    );
    await expect(
      service.readManifest("user-1", "proj-1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws ManifestInvalidError (422) on non-JSON content", async () => {
    const { service } = makeService({ file: fileOf("{ this is not json") });
    await expect(
      service.readManifest("user-1", "proj-1"),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.readManifest("user-1", "proj-1")).rejects.toBeInstanceOf(
      ManifestInvalidError,
    );
  });

  it("throws ManifestInvalidError (422) when JSON fails ProjectManifestSchema", async () => {
    const { service } = makeService({
      file: fileOf(JSON.stringify({ ...VALID_MANIFEST, manifestVersion: 2 })),
    });
    await expect(
      service.readManifest("user-1", "proj-1"),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.readManifest("user-1", "proj-1")).rejects.toBeInstanceOf(
      ManifestInvalidError,
    );
  });

  it("throws GithubNotConnectedError (409) and does NOT fetch when unconnected", async () => {
    const { service, getFileContents } = makeService({
      connection: null,
      file: fileOf(JSON.stringify(VALID_MANIFEST)),
    });
    await expect(service.readManifest("user-1", "proj-1")).rejects.toBeInstanceOf(
      GithubNotConnectedError,
    );
    expect(getFileContents).not.toHaveBeenCalled();
  });

  it("propagates ProjectNotFoundError and does NOT fetch when the project is unresolved", async () => {
    const { service, getFileContents } = makeService({
      getProjectErr: new ProjectNotFoundError(),
      file: fileOf(JSON.stringify(VALID_MANIFEST)),
    });
    await expect(service.readManifest("user-1", "nope")).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    expect(getFileContents).not.toHaveBeenCalled();
  });
});
