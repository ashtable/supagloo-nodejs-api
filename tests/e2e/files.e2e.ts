import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import {
  createPrismaClient,
  buildAssetKey,
  buildRenderOutputKey,
  type PrismaClient,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { makeS3Client, type S3EnvConfig } from "../../src/files/s3-client";
import { FilesService } from "../../src/files/files-service";

// Non-UI e2e for the presigned-download surface (Task #13, design-delta §4/§8).
// Boots the REAL Fastify app in-process (real listen + real fetch) wired to REAL
// Postgres (Compose `supagloo` DB) and the REAL Compose MinIO. No mocking — objects
// are PUT into MinIO, the API presigns a GET URL signed against S3_PUBLIC_ENDPOINT
// (localhost:9000), and the test fetches that URL from the host to round-trip the
// bytes. Ownership scoping is exercised end-to-end: a foreign user gets a uniform
// 404. Infra ensured by tests/e2e/global-setup.ts (reuse-or-spawn: postgres +
// stubs + minio/minio-init). Runs IN-PROCESS per the in-flight-dblib-e2e constraint
// (the containerized API cannot yet see the uncommitted db-lib key helpers).

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";

const S3_CFG: S3EnvConfig = {
  internalEndpoint: process.env.S3_ENDPOINT ?? "http://minio:9000",
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  bucket: process.env.S3_BUCKET ?? "supagloo-dev",
  accessKey: process.env.S3_ACCESS_KEY ?? "supagloo",
  secretKey: process.env.S3_SECRET_KEY ?? "supagloo-dev",
};

describe("e2e: presigned download + ownership scoping", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let s3: S3Client;
  let baseUrl: string;
  const putKeys: string[] = [];

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: APP_URL });
    // The presign client signs against the PUBLIC endpoint; the test runs on the
    // host, so it also uses this client to PUT fixtures + create the bucket.
    s3 = makeS3Client(S3_CFG, "presign");
    // Defensive: create the bucket if minio-init hasn't (idempotent).
    await s3
      .send(new CreateBucketCommand({ Bucket: S3_CFG.bucket }))
      .catch(() => {});

    const authService = new AuthService({
      prisma,
      verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
      sessionTtlMs: SESSION_TTL_MS,
    });
    const filesService = new FilesService({
      prisma,
      s3,
      bucket: S3_CFG.bucket,
    });

    app = buildApp({
      auth: {
        authService,
        env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
      },
      files: { service: filesService },
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    for (const key of putKeys) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: S3_CFG.bucket, Key: key }))
        .catch(() => {});
    }
    if (s3) s3.destroy();
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const token = `files-e2e-${tag}-${stamp}`;
    const res = await fetch(`${baseUrl}/v1/test/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        users: [
          {
            youversionUserId: `yv-files-${tag}-${stamp}`,
            displayName: `Files E2E ${tag}`,
            email: `files-${tag}-${stamp}@example.test`,
            avatarInitials: "FE",
            sessionToken: token,
          },
        ],
      }),
    });
    const body = await res.json();
    return { token, userId: body.users[0].user.id };
  }

  async function putObject(key: string, body: string): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_CFG.bucket,
        Key: key,
        Body: body,
        ContentType: "text/plain",
      }),
    );
    putKeys.push(key);
  }

  async function makeProject(ownerId: string): Promise<string> {
    const slug = `files-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const project = await prisma.project.create({
      data: {
        slug,
        ownerId,
        name: slug,
        repoOwner: "ashtable",
        repoName: slug,
        repoVisibility: "private",
        createdFrom: "blank",
        currentBranch: "v0.0.1",
      },
    });
    return project.id;
  }

  async function makeRenderJob(projectId: string, userId: string): Promise<string> {
    const version = await prisma.projectVersion.create({
      data: {
        projectId,
        semver: "0.0.1",
        branchName: "v0.0.1",
        state: "base",
        changedFiles: [],
      },
    });
    const id = `files-e2e-rj-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await prisma.renderJob.create({
      data: {
        id,
        projectId,
        versionId: version.id,
        userId,
        status: "completed",
        width: 1080,
        height: 1920,
        fps: 30,
        aspectRatio: "9:16",
        codec: "h264",
        runInBackground: false,
      },
    });
    return id;
  }

  const presign = (key: string, token?: string) =>
    fetch(
      `${baseUrl}/v1/files/presign-download?key=${encodeURIComponent(key)}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    );

  // ------------------------------------------------------------ project-asset

  it("presigns an owned project-asset key + round-trips the bytes from the host", async () => {
    const owner = await seedUser("owner");
    const projectId = await makeProject(owner.userId);
    const key = buildAssetKey(projectId, "asset-1");
    const contents = `asset-body-${Math.random()}`;
    await putObject(key, contents);

    const res = await presign(key, owner.token);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Signed against the browser-reachable endpoint, not minio:9000.
    expect(new URL(body.url).host).toBe("localhost:9000");
    expect(body.url).toContain("X-Amz-Signature");
    expect(typeof body.expiresAt).toBe("string");

    // The presigned URL actually resolves the object.
    const fetched = await fetch(body.url);
    expect(fetched.ok).toBe(true);
    expect(await fetched.text()).toBe(contents);
  });

  it("denies a foreign user's project-asset key with 404 (cross-user)", async () => {
    const owner = await seedUser("a");
    const other = await seedUser("b");
    const projectId = await makeProject(owner.userId);
    const key = buildAssetKey(projectId, "asset-1");
    await putObject(key, "secret");

    const res = await presign(key, other.token);
    expect(res.status).toBe(404);
  });

  it("denies a key for a non-existent project with 404 (indistinguishable from foreign)", async () => {
    const owner = await seedUser("ghost");
    const res = await presign(buildAssetKey("no-such-project", "asset-1"), owner.token);
    expect(res.status).toBe(404);
  });

  // ------------------------------------------------------------------- render

  it("presigns an owned render-output key + round-trips; denies it cross-user", async () => {
    const owner = await seedUser("render-owner");
    const other = await seedUser("render-other");
    const projectId = await makeProject(owner.userId);
    const renderJobId = await makeRenderJob(projectId, owner.userId);
    const key = buildRenderOutputKey(renderJobId);
    const contents = `render-bytes-${Math.random()}`;
    await putObject(key, contents);

    const ok = await presign(key, owner.token);
    expect(ok.status).toBe(200);
    const fetched = await fetch((await ok.json()).url);
    expect(await fetched.text()).toBe(contents);

    const denied = await presign(key, other.token);
    expect(denied.status).toBe(404);
  });

  // --------------------------------------------------------- malformed / auth

  it("rejects a malformed/unrecognized key with 404", async () => {
    const owner = await seedUser("malformed");
    const res = await presign("not/a/valid/key/shape", owner.token);
    expect(res.status).toBe(404);
  });

  it("401s without a bearer token", async () => {
    const res = await presign(buildAssetKey("p1", "a1"));
    expect(res.status).toBe(401);
  });
});
