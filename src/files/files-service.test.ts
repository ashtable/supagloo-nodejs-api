import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import {
  buildAssetKey,
  buildRenderOutputKey,
  buildRenderThumbnailKey,
} from "@supagloo/database-lib";
import { FilesService } from "./files-service";
import { makeS3Client, type S3EnvConfig } from "./s3-client";
import { FileAccessDeniedError } from "./errors";

// Unit tests for the FilesService presign + ownership logic (Task #13, design-delta
// §4/§8). A FAKE Prisma records the exact ownership lookups; a REAL S3Client is used
// because `getSignedUrl` signs the URL LOCALLY (no network). The endpoint-selection
// invariant is asserted here: the signed URL host is the PUBLIC endpoint. Ownership
// denial (foreign / not-found / malformed) always surfaces as FileAccessDeniedError
// (404), never distinguishing the three so existence can't leak.

const S3_CFG: S3EnvConfig = {
  internalEndpoint: "http://minio:9000",
  publicEndpoint: "http://localhost:9000",
  region: "us-east-1",
  bucket: "supagloo-dev",
  accessKey: "AKIAEXAMPLE",
  secretKey: "examplesecret",
};

function makeFakePrisma(rows: { project?: unknown; renderJob?: unknown }) {
  const calls: { table: string; where: unknown }[] = [];
  const table = (name: string, value: unknown) => ({
    findUnique: (a: { where: unknown }) => {
      calls.push({ table: name, where: a.where });
      return Promise.resolve(value ?? null);
    },
  });
  const prisma = {
    project: table("project", rows.project),
    renderJob: table("renderJob", rows.renderJob),
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

function makeService(
  rows: { project?: unknown; renderJob?: unknown },
  opts: { now?: () => Date; expiresInSeconds?: number } = {},
) {
  const { prisma, calls } = makeFakePrisma(rows);
  const s3 = makeS3Client(S3_CFG, "presign");
  const service = new FilesService({
    prisma,
    s3,
    bucket: S3_CFG.bucket,
    expiresInSeconds: opts.expiresInSeconds ?? 300,
    now: opts.now,
  });
  return { service, calls, s3 };
}

describe("FilesService.presignDownload — project-asset keys", () => {
  it("presigns an owned key against the PUBLIC endpoint with the right expiry", async () => {
    const now = () => new Date("2026-07-18T00:00:00.000Z");
    const { service, calls, s3 } = makeService(
      { project: { ownerId: "u1" } },
      { now, expiresInSeconds: 300 },
    );
    const key = buildAssetKey("proj-1", "asset-1");

    const res = await service.presignDownload("u1", key);

    const url = new URL(res.url);
    // Signed against S3_PUBLIC_ENDPOINT (browser-reachable), NOT minio:9000.
    expect(url.host).toBe("localhost:9000");
    // The key path is present and the URL is actually signed.
    expect(url.pathname).toBe(`/supagloo-dev/${key}`);
    expect(res.url).toContain("X-Amz-Signature");
    // expiresAt = now + expiresIn.
    expect(res.expiresAt.toISOString()).toBe("2026-07-18T00:05:00.000Z");
    // Ownership resolved by loading the Project by id.
    expect(calls).toEqual([{ table: "project", where: { id: "proj-1" } }]);
    s3.destroy();
  });

  it("rejects a key owned by another user with 404 (no leak)", async () => {
    const { service } = makeService({ project: { ownerId: "someone-else" } });
    await expect(
      service.presignDownload("u1", buildAssetKey("proj-1", "asset-1")),
    ).rejects.toBeInstanceOf(FileAccessDeniedError);
  });

  it("rejects a key whose project does not exist with 404", async () => {
    const { service } = makeService({}); // project → null
    await expect(
      service.presignDownload("u1", buildAssetKey("ghost", "asset-1")),
    ).rejects.toBeInstanceOf(FileAccessDeniedError);
  });
});

describe("FilesService.presignDownload — render keys", () => {
  it("presigns an owned render-output key (userId ownership, direct field)", async () => {
    const { service, calls } = makeService({ renderJob: { userId: "u1" } });
    const key = buildRenderOutputKey("rj-1");

    const res = await service.presignDownload("u1", key);

    expect(new URL(res.url).host).toBe("localhost:9000");
    expect(res.url).toContain("output.mp4");
    expect(res.url).toContain("X-Amz-Signature");
    expect(calls).toEqual([{ table: "renderJob", where: { id: "rj-1" } }]);
  });

  it("presigns an owned render-thumbnail key", async () => {
    const { service } = makeService({ renderJob: { userId: "u1" } });
    const res = await service.presignDownload("u1", buildRenderThumbnailKey("rj-1"));
    expect(res.url).toContain("thumb.jpg");
  });

  it("rejects a render key owned by another user with 404", async () => {
    const { service } = makeService({ renderJob: { userId: "someone-else" } });
    await expect(
      service.presignDownload("u1", buildRenderOutputKey("rj-1")),
    ).rejects.toBeInstanceOf(FileAccessDeniedError);
  });

  it("rejects a render key whose job does not exist with 404", async () => {
    const { service } = makeService({}); // renderJob → null
    await expect(
      service.presignDownload("u1", buildRenderOutputKey("ghost")),
    ).rejects.toBeInstanceOf(FileAccessDeniedError);
  });
});

describe("FilesService.presignDownload — malformed keys", () => {
  const malformed = [
    "",
    "foo",
    "projects/p1",
    "projects/p1/assets/a1/extra",
    "renders/rj/evil.exe",
    "projects/../assets/a1",
    "/projects/p1/assets/a1",
  ];

  for (const bad of malformed) {
    it(`rejects ${JSON.stringify(bad)} with 404 and NO database lookup`, async () => {
      // Both tables would "own" if consulted — proves the reject is pre-DB.
      const { service, calls } = makeService({
        project: { ownerId: "u1" },
        renderJob: { userId: "u1" },
      });
      await expect(service.presignDownload("u1", bad)).rejects.toBeInstanceOf(
        FileAccessDeniedError,
      );
      expect(calls).toEqual([]);
    });
  }
});
