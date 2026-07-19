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
