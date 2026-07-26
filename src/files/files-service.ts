import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  parseS3Key,
  type ParsedS3Key,
  type PrismaClient,
} from "@supagloo/database-lib";
import { FileAccessDeniedError } from "./errors";

/**
 * S3 presigned-download service (design-delta §4/§8). Backs the single route
 * `GET /v1/files/presign-download?key=`. It:
 *   1. parses the requested key with the SHARED db-lib layout helper (so the format
 *      matches whatever the render/git-ops workflows wrote),
 *   2. scopes the key to the caller — `projects/{id}/…` → `Project.ownerId`,
 *      `renders/{id}/…` → `RenderJob.userId`,
 *   3. presigns a short-lived GET URL against the PUBLIC endpoint (the S3Client is
 *      constructed against `S3_PUBLIC_ENDPOINT` by the composition root).
 *
 * Any parse failure, missing row, or ownership mismatch throws
 * {@link FileAccessDeniedError} (404) — the three are indistinguishable on the wire.
 * Uploads and deletes are NOT here (server-side worker ops / cleanup workflow).
 *
 * It also owns ONE ownership-free signer, {@link FilesService.presignPublicKey}, which the
 * gallery calls through an injected seam so the whole process still has exactly one S3 URL
 * signer. Its own JSDoc explains why that is a separate method rather than a flag on
 * `presignDownload`.
 */
export interface FilesServiceOptions {
  prisma: PrismaClient;
  /** An S3Client already pointed at the PUBLIC endpoint (see `makeS3Client`). */
  s3: S3Client;
  bucket: string;
  /** Presigned-URL lifetime in seconds. Default 300 (5 min). */
  expiresInSeconds?: number;
  /** Injectable clock for a deterministic `expiresAt`. Defaults to wall-clock. */
  now?: () => Date;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export class FilesService {
  private readonly prisma: PrismaClient;
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly expiresInSeconds: number;
  private readonly now: () => Date;

  constructor(opts: FilesServiceOptions) {
    this.prisma = opts.prisma;
    this.s3 = opts.s3;
    this.bucket = opts.bucket;
    this.expiresInSeconds = opts.expiresInSeconds ?? 300;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Presign a GET URL for `key` if `userId` owns the referenced object.
   * @throws {FileAccessDeniedError} on a malformed key, missing row, or foreign row.
   */
  async presignDownload(userId: string, key: string): Promise<PresignedDownload> {
    const parsed = parseS3Key(key);
    if (!parsed) throw new FileAccessDeniedError();

    await this.assertOwnership(userId, parsed);

    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.expiresInSeconds },
    );
    const expiresAt = new Date(
      this.now().getTime() + this.expiresInSeconds * 1000,
    );
    return { url, expiresAt };
  }

  /**
   * Presign a GET URL for `key` with **no ownership check at all** (Task #39, plan D13).
   *
   * `GET /v1/gallery/:id/stream-url` is the first presign this process issues to a caller who
   * owns nothing, so ownership is the wrong question to ask. WHY A SEPARATE METHOD rather
   * than teaching {@link assertOwnership} about gallery visibility: publication is a
   * DIFFERENT authorization fact from ownership, and folding it in would make one function
   * answer two unrelated questions — and risk the gallery rule leaking onto
   * `GET /v1/files/presign-download`.
   *
   * What is preserved is the pair of invariants that actually matter:
   *   1. `parseS3Key` still runs, so a malformed key never reaches S3 (404, as ever); and
   *   2. the SAME `S3Role="presign"` client signs, so the design's "the API is the only S3
   *      URL signer" rule holds with exactly ONE signer in the process.
   *
   * THE AUTHORIZATION LIVES IN `GalleryService`: the item must exist (both `public` and
   * `unlisted` are served), and no caller ever supplies a key — it is recomputed from the
   * item's `renderJobId`.
   *
   * `expiresInSeconds` defaults to this service's configured lifetime, but the gallery passes
   * a deliberately shorter one (120 s): for an unauthenticated caller the URL *is* the
   * credential.
   *
   * HONEST LIMITATION: an HTTP range session already in flight continues past expiry. The TTL
   * bounds NEW requests, not the stream currently being served.
   *
   * @throws {FileAccessDeniedError} on a malformed key, before touching S3 or the database.
   */
  async presignPublicKey(
    key: string,
    expiresInSeconds?: number,
  ): Promise<PresignedDownload> {
    const parsed = parseS3Key(key);
    if (!parsed) throw new FileAccessDeniedError();

    const expiresIn = expiresInSeconds ?? this.expiresInSeconds;
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
    return {
      url,
      expiresAt: new Date(this.now().getTime() + expiresIn * 1000),
    };
  }

  /** Load the owning row for the parsed key and require it to belong to `userId`. */
  private async assertOwnership(
    userId: string,
    parsed: ParsedS3Key,
  ): Promise<void> {
    if (parsed.kind === "project-asset") {
      const project = await this.prisma.project.findUnique({
        where: { id: parsed.projectId },
        select: { ownerId: true },
      });
      if (!project || project.ownerId !== userId) {
        throw new FileAccessDeniedError();
      }
      return;
    }

    // render-output | render-thumbnail — ownership is the direct RenderJob.userId.
    const job = await this.prisma.renderJob.findUnique({
      where: { id: parsed.renderJobId },
      select: { userId: true },
    });
    if (!job || job.userId !== userId) {
      throw new FileAccessDeniedError();
    }
  }
}
