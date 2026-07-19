import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "@supagloo/database-lib";

// Reuse-or-spawn e2e infra for the API auth suite. The auth e2e boots the Fastify
// app IN-PROCESS (real listen + real fetch) but needs two real dependencies from
// the root Compose stack: Postgres (with db-lib migrations applied) and the
// containerized YouVersion stub (with the Task #10 /auth/v1/userinfo route).
//
// This mirrors the root repo's reuse-or-spawn harness: if a healthy stack is
// already up (e.g. the developer ran the root e2e), reuse it untouched; otherwise
// bring up just `postgres` + `youversion-stub` from the root Compose files, apply
// migrations with the API's own prisma CLI, and tear down on exit.
//
// NOTE (deviation from the "API e2e does no docker orchestration" convention):
// auth genuinely needs infra, so we adopt the same reuse-or-spawn pattern the root
// harness uses. It stays a no-op when a stack is already running.

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_REPO =
  process.env.SUPAGLOO_ROOT_DIR ?? resolve(API_ROOT, "..", "supagloo");

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_STUB_URL ?? "http://localhost:4804";
const GITHUB_BASE = process.env.GITHUB_STUB_URL ?? "http://localhost:4801";

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

async function stubReady(): Promise<boolean> {
  try {
    const health = await fetch(`${YOUVERSION_BASE}/__stub/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok) return false;
    // A stale stub image (built before Task #10) lacks the userinfo route and
    // would 404; a current one 401s an invalid token. Distinguish them so a
    // reused-but-stale stack is rebuilt rather than silently failing the suite.
    const probe = await fetch(`${YOUVERSION_BASE}/auth/v1/userinfo`, {
      headers: { authorization: "Bearer yv-access-invalid" },
      signal: AbortSignal.timeout(3000),
    });
    return probe.status === 401;
  } catch {
    return false;
  }
}

async function githubStubReady(): Promise<boolean> {
  try {
    const health = await fetch(`${GITHUB_BASE}/__stub/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok) return false;
    // A stale github-stub image (built before Task #11) lacks the repo-listing
    // route and would 404; a current one 401s an unauthenticated request.
    // Distinguish them so a reused-but-stale stack is rebuilt.
    const probe = await fetch(`${GITHUB_BASE}/installation/repositories`, {
      signal: AbortSignal.timeout(3000),
    });
    return probe.status === 401;
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
  if ((await dbReady()) && (await stubReady()) && (await githubStubReady())) {
    // Reuse a healthy running stack — leave it exactly as-is.
    return;
  }

  if (!existsSync(resolve(ROOT_REPO, "docker-compose.yml"))) {
    throw new Error(
      `API e2e needs Postgres + the YouVersion + GitHub stubs, but neither a ` +
        `running stack nor the root Compose repo was found at ${ROOT_REPO}. Bring ` +
        `up the stack (root repo: docker compose ... up) or set SUPAGLOO_ROOT_DIR.`,
    );
  }

  // `--build` so the stub images include the Task #10 userinfo + Task #11 repo
  // routes.
  compose([
    "up",
    "-d",
    "--build",
    "postgres",
    "youversion-stub",
    "github-stub",
  ]);

  if (!(await waitFor(pgConnectable, 90_000))) {
    compose(["down"]);
    throw new Error("Postgres did not accept connections within 90s");
  }
  migrate();
  if (!(await waitFor(stubReady, 60_000))) {
    compose(["down"]);
    throw new Error("YouVersion stub (with userinfo route) not ready within 60s");
  }
  if (!(await waitFor(githubStubReady, 60_000))) {
    compose(["down"]);
    throw new Error("GitHub stub (with repo-listing route) not ready within 60s");
  }

  return async () => {
    compose(["down"]);
  };
}
