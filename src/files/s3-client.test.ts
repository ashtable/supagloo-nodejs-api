import { describe, it, expect } from "vitest";
import { makeS3Client, selectEndpoint, type S3EnvConfig } from "./s3-client";

// Unit tests for the S3 client factory (Task #13, design-delta §4). The load-bearing
// rule: presigning MUST sign against the PUBLIC (browser-reachable) endpoint, while
// server-to-server ops (reserved for workers) use the INTERNAL Docker-network
// endpoint. `forcePathStyle` is mandatory for MinIO. No network here.

const cfg: S3EnvConfig = {
  internalEndpoint: "http://minio:9000",
  publicEndpoint: "http://localhost:9000",
  region: "us-east-1",
  bucket: "supagloo-dev",
  accessKey: "supagloo",
  secretKey: "supagloo-dev",
};

describe("selectEndpoint", () => {
  it("selects the PUBLIC endpoint for presigning", () => {
    expect(selectEndpoint(cfg, "presign")).toBe("http://localhost:9000");
  });

  it("selects the INTERNAL endpoint for server-to-server ops", () => {
    expect(selectEndpoint(cfg, "internal")).toBe("http://minio:9000");
  });
});

describe("makeS3Client", () => {
  it("builds a forcePathStyle client with the configured region", async () => {
    const client = makeS3Client(cfg);
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe("us-east-1");
    client.destroy();
  });

  it("defaults to the presign (public) endpoint", async () => {
    const client = makeS3Client(cfg);
    const endpoint = await client.config.endpoint!();
    expect(endpoint.hostname).toBe("localhost");
    expect(endpoint.port).toBe(9000);
    client.destroy();
  });

  it("can build an internal-endpoint client when asked", async () => {
    const client = makeS3Client(cfg, "internal");
    const endpoint = await client.config.endpoint!();
    expect(endpoint.hostname).toBe("minio");
    client.destroy();
  });
});
