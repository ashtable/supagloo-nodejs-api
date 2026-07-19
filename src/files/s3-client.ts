import { S3Client } from "@aws-sdk/client-s3";

/**
 * S3 client factory (design-delta §4, [[minio-local-s3-parity]]).
 *
 * The API talks to S3-compatible storage (MinIO in local dev, the Railway bucket in
 * prod). It holds TWO endpoints:
 *  - `internalEndpoint` (`S3_ENDPOINT`, e.g. `minio:9000`) for server-to-server ops
 *    inside the Docker network — reserved for the workers, not used by the API today.
 *  - `publicEndpoint` (`S3_PUBLIC_ENDPOINT`, e.g. `localhost:9000`) which is
 *    browser-reachable. Presigned URLs MUST be signed against THIS endpoint — a URL
 *    signed against the internal address is unreachable from a browser.
 *
 * `forcePathStyle: true` is mandatory: MinIO has no vhost-style bucket DNS.
 */
export interface S3EnvConfig {
  /** Internal Docker-network endpoint (`S3_ENDPOINT`). */
  internalEndpoint: string;
  /** Browser-reachable endpoint used to SIGN presigned URLs (`S3_PUBLIC_ENDPOINT`). */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

/** Which network role the client is for. `presign` → the public endpoint (the only
 *  role the API uses); `internal` → the Docker-network endpoint (worker ops). */
export type S3Role = "presign" | "internal";

/** Resolve the endpoint for a role. Presigning always uses the public endpoint. */
export function selectEndpoint(config: S3EnvConfig, role: S3Role): string {
  return role === "presign" ? config.publicEndpoint : config.internalEndpoint;
}

/**
 * Build an AWS SDK v3 {@link S3Client} for the given role (defaults to `presign`,
 * the API's only use). `forcePathStyle` is always on for MinIO compatibility.
 */
export function makeS3Client(
  config: S3EnvConfig,
  role: S3Role = "presign",
): S3Client {
  return new S3Client({
    endpoint: selectEndpoint(config, role),
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}
