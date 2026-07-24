import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "@supagloo/database-lib";

// Reuse-or-spawn e2e infra for the API e2e suites. They boot the Fastify app
// IN-PROCESS (real listen + real fetch) but need real dependencies from the root
// Compose stack: Postgres (with db-lib migrations applied), the containerized
// GitHub stub (REST + repo + Contents routes), and MinIO (S3 store + bucket).
//
// This mirrors the root repo's reuse-or-spawn harness: if a healthy stack is
// already up (e.g. the developer ran the root e2e), reuse it untouched; otherwise
// bring up just `postgres` + `github-stub` + `minio(-init)` from the root Compose
// files, apply migrations with the API's own prisma CLI, and tear down on exit.
//
// Task 34-E8 (design-delta §10.7): the openrouter/gloo/youversion stubs are GONE.
// The real-provider e2e specs (connections.e2e) reach the LIVE hosts and fail fast
// on missing secrets via their own `resolveConnectionSeedCreds()` — no stub, and no
// provider secret is needed HERE just to bring up infra, so this global-setup does
// not gate on provider secrets (they belong to the specs that actually use them).
//
// NOTE (deviation from the "API e2e does no docker orchestration" convention): the
// e2e genuinely needs infra, so we adopt the same reuse-or-spawn pattern the root
// harness uses. It stays a no-op when a stack is already running.

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_REPO =
  process.env.SUPAGLOO_ROOT_DIR ?? resolve(API_ROOT, "..", "supagloo");

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const GITHUB_BASE = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";
// MinIO (Task #13): the files e2e presigns + round-trips against the Compose MinIO.
// Probe the host-reachable (public) endpoint's health route.
const MINIO_BASE = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function composeFiles(): string[] {
  const files = ["docker-compose.yml"];
  if (existsSync(resolve(ROOT_REPO, "docker-compose.override.yml"))) {
    files.push("docker-compose.override.yml");
  }
  files.push("docker-compose.test.yml");
  return files;
}

function compose(args: string[]): void {
  const fileArgs = composeFiles().flatMap((f) => ["-f", f]);
  execFileSync("docker", ["compose", ...fileArgs, ...args], {
    cwd: ROOT_REPO,
    stdio: "inherit",
  });
}

async function pgConnectable(): Promise<boolean> {
  const prisma = createPrismaClient({ connectionString: APP_URL });
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function dbReady(): Promise<boolean> {
  const prisma = createPrismaClient({ connectionString: APP_URL });
  try {
    // Throws unless the User table exists (migrations applied) AND reachable.
    await prisma.user.count();
    return true;
  } catch {
    return false;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function githubStubReady(): Promise<boolean> {
  try {
    const health = await fetch(`${GITHUB_BASE}/__stub/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok) return false;
    // Probe the NEWEST route (Task #20 Contents API). A stale github-stub image
    // (built before Task #20) lacks it and would 404 (unmatched); a current one
    // 401s an unauthenticated request (it requires an installation token). Any stub
    // with this route also has the earlier install/repos routes, so probing the
    // newest one is sufficient — a reused-but-stale stack is rebuilt.
    const probe = await fetch(
      `${GITHUB_BASE}/repos/acme/probe/contents/supagloo.project.json?ref=main`,
      { signal: AbortSignal.timeout(3000) },
    );
    return probe.status === 401;
  } catch {
    return false;
  }
}

async function minioReady(): Promise<boolean> {
  try {
    // MinIO's liveness endpoint; 200 once the server is accepting requests. The
    // bucket itself is created by the one-shot `minio-init` service; the files e2e
    // additionally CreateBucket (idempotent) so it never races that init.
    const health = await fetch(`${MINIO_BASE}/minio/health/live`, {
      signal: AbortSignal.timeout(3000),
    });
    return health.ok;
  } catch {
    return false;
  }
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(2000);
  }
  return false;
}

function migrate(): void {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(npx, ["prisma", "migrate", "deploy"], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: APP_URL },
    stdio: "inherit",
  });
}

export default async function setup() {
  if (
    (await dbReady()) &&
    (await githubStubReady()) &&
    (await minioReady())
  ) {
    // Reuse a healthy running stack — leave it exactly as-is.
    return;
  }

  if (!existsSync(resolve(ROOT_REPO, "docker-compose.yml"))) {
    throw new Error(
      `API e2e needs Postgres + the GitHub stub + MinIO, but neither a running ` +
        `stack nor the root Compose repo was found at ${ROOT_REPO}. Bring up the ` +
        `stack (root repo: docker compose ... up) or set SUPAGLOO_ROOT_DIR.`,
    );
  }

  // `--build` so the github-stub image includes the Task #11 repo + Task #20 Contents
  // routes. `minio` + `minio-init` provide the Task #13 S3 store + `supagloo-dev` bucket.
  compose([
    "up",
    "-d",
    "--build",
    "postgres",
    "github-stub",
    "minio",
    "minio-init",
  ]);

  if (!(await waitFor(pgConnectable, 90_000))) {
    compose(["down"]);
    throw new Error("Postgres did not accept connections within 90s");
  }
  migrate();
  if (!(await waitFor(githubStubReady, 60_000))) {
    compose(["down"]);
    throw new Error("GitHub stub (with repo-listing route) not ready within 60s");
  }
  if (!(await waitFor(minioReady, 60_000))) {
    compose(["down"]);
    throw new Error("MinIO not ready within 60s");
  }

  return async () => {
    compose(["down"]);
  };
}
