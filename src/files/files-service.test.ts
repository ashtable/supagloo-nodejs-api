import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@supagloo/database-lib";
import {
  buildAssetKey,
  buildRenderOutputKey,
  buildRenderThumbnailKey,
} from "@supagloo/database-lib";
import { DEMO_VIDEO_KEY, FilesService } from "./files-service";
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

// -------------------------------------------------------- presignPublicKey (Task #39)

// `GET /v1/gallery/:id/stream-url` is the first presign this process issues to a caller
// who owns NOTHING, so `presignPublicKey` performs NO ownership lookup (plan D13).
//
// Why a separate method rather than teaching `assertOwnership` about gallery visibility:
// publication is a DIFFERENT authorization fact from ownership. Folding it in would make
// one function answer two unrelated questions and risk the gallery rule leaking onto
// `GET /v1/files/presign-download`. What is preserved is the pair of invariants that
// matter — `parseS3Key` still runs (a malformed key never reaches S3) and the SAME
// `S3Role="presign"` client signs, so the design's "the API is the only S3 URL signer"
// rule still holds with exactly ONE signer in the process.
//
// The AUTHORIZATION lives in GalleryService: the item must exist, and the route never
// accepts a key — it recomputes `buildRenderOutputKey(item.renderJobId)`.
describe("FilesService.presignPublicKey — the public (ownership-free) signer", () => {
  it("signs without ANY database lookup, against the PUBLIC endpoint", async () => {
    const now = () => new Date("2026-07-26T12:00:00.000Z");
    // Both tables are populated with rows owned by someone else entirely: if this method
    // consulted either, the fake would record it AND the "ownership" would not match.
    const { service, calls } = makeService(
      { project: { ownerId: "someone-else" }, renderJob: { userId: "someone-else" } },
      { now },
    );
    const key = buildRenderOutputKey("rj-1");

    const res = await service.presignPublicKey(key, 120);

    const url = new URL(res.url);
    expect(url.host).toBe("localhost:9000");
    expect(url.pathname).toBe(`/supagloo-dev/${key}`);
    expect(res.url).toContain("X-Amz-Signature");
    // No ownership query at all — that is the whole point of the method.
    expect(calls).toEqual([]);
  });

  it("honours an explicit short TTL (the gallery's 120 s) and reports the matching expiresAt", async () => {
    const now = () => new Date("2026-07-26T12:00:00.000Z");
    const { service } = makeService({}, { now, expiresInSeconds: 300 });

    const res = await service.presignPublicKey(buildRenderOutputKey("rj-1"), 120);

    // The URL IS the credential for an unauthenticated caller, so the caller's TTL must
    // win over the service's 300 s default rather than being silently widened.
    expect(new URL(res.url).searchParams.get("X-Amz-Expires")).toBe("120");
    expect(res.expiresAt.toISOString()).toBe("2026-07-26T12:02:00.000Z");
  });

  it("falls back to the service's configured TTL when none is given", async () => {
    const now = () => new Date("2026-07-26T12:00:00.000Z");
    const { service } = makeService({}, { now, expiresInSeconds: 300 });
    const res = await service.presignPublicKey(buildRenderThumbnailKey("rj-1"));
    expect(new URL(res.url).searchParams.get("X-Amz-Expires")).toBe("300");
    expect(res.expiresAt.toISOString()).toBe("2026-07-26T12:05:00.000Z");
  });

  it("STILL rejects a malformed key with 404, before touching S3 or the database", async () => {
    for (const bad of [
      "",
      "foo",
      "renders/rj/evil.exe",
      "projects/../assets/a1",
      "/renders/rj-1/output.mp4",
      "renders/rj-1/output.mp4/extra",
    ]) {
      const { service, calls } = makeService({
        project: { ownerId: "u1" },
        renderJob: { userId: "u1" },
      });
      await expect(service.presignPublicKey(bad, 120), bad).rejects.toBeInstanceOf(
        FileAccessDeniedError,
      );
      expect(calls, bad).toEqual([]);
    }
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

describe("FilesService.presignDemoVideo — the landing page's public demo", () => {
  it("signs the module constant, and takes no key to sign anything else", async () => {
    const now = () => new Date("2026-07-29T00:00:00.000Z");
    const { service, calls } = makeService({}, { now, expiresInSeconds: 300 });

    const res = await service.presignDemoVideo(120);

    const url = new URL(res.url);
    // Path-style against the PUBLIC endpoint, like every other presign here.
    expect(url.host).toBe("localhost:9000");
    expect(url.pathname).toBe(`/${S3_CFG.bucket}/${DEMO_VIDEO_KEY}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(res.expiresAt.toISOString()).toBe("2026-07-29T00:02:00.000Z");

    // No database lookup at all: there is no row to authorize, which is exactly why the
    // key must not be caller-supplied.
    expect(calls).toEqual([]);
  });

  it("cannot be asked to sign a different object", () => {
    // The security property, asserted against the SIGNATURE rather than the behaviour:
    // `presignDemoVideo` accepts a TTL and nothing else. If a `key` parameter is ever
    // added, this stops compiling and the reviewer has to justify it — which is the
    // point, because this method is reachable with no authentication at all.
    const { service } = makeService({});
    expect(service.presignDemoVideo).toHaveLength(1); // (expiresInSeconds?) only
    expect(DEMO_VIDEO_KEY).toBe("demos/genesis-1-demo.mp4");
  });

  it("falls back to the service TTL when none is given", async () => {
    const now = () => new Date("2026-07-29T00:00:00.000Z");
    const { service } = makeService({}, { now, expiresInSeconds: 300 });
    const res = await service.presignDemoVideo();
    expect(new URL(res.url).searchParams.get("X-Amz-Expires")).toBe("300");
  });
});
