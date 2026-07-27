import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  createPrismaClient,
  type PrismaClient,
  SCAFFOLD_PROJECT_WORKFLOW_NAME,
  GIT_OPS_QUEUE_NAME,
  SCAFFOLD_STAGES,
  buildInitialStages,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { ProjectsService } from "../../src/projects/projects-service";
import { ProjectJobsService } from "../../src/jobs/project-jobs-service";
import { makeDbosEnqueuer } from "../../src/jobs/enqueuer";
import {
  assertLaneRuntimeIsolated,
  assertWorkflowIsolated,
  laneSystemSchema,
  resetLaneSchema,
} from "../../src/testing/dbos-lane-isolation";
import { makeGithubUserAuthClient } from "../../src/connections/github-user-auth-client";
import { RepoProvisioningService } from "../../src/projects/repo-provisioning-service";
import {
  githubApiBaseUrl,
  githubOauthBaseUrl,
  loadRootE2eHarness,
  mintE2eInstallationToken,
  resolveGithubE2eContext,
  resolveGithubOauthClientCreds,
  seedGithubConnection,
  shimOnlyTheUserAuthorizationTokenExchange,
  type GithubE2eContext,
  type GithubOauthClientCreds,
} from "../../src/testing/github-e2e";

// Non-UI e2e for the Task #26 create-new-repo JIT hop (design-delta §2.3/§6b/§8),
// REPOINTED AT REAL GITHUB in task-62 (D13 **tier 1**). Boots the REAL Fastify app
// in-process (real listen + fetch) with the REAL user-auth client, a REAL DBOSClient
// enqueuer, AND the SAME stand-in `scaffoldProject` worker the task-18 e2e uses (so the
// delegated create job advances queued→running→succeeded).
//
// ONE HOP IS SHIMMED, AND ONLY ONE: `POST https://github.com/login/oauth/access_token`.
// Steps 2–3 of the designed flow are a HUMAN clicking "Authorize" on a GitHub-hosted
// consent page and the short-lived `code` that click produces. Those cannot be
// automated headlessly, and a fabricated code is rejected by real GitHub with
// `bad_verification_code` (the retired github-stub accepted any non-empty string, which
// is the only reason `code=e2e-create-repo-code` ever "worked"). So the exchange is
// answered with `GITHUB_E2E_PAT_TOKEN` — a user-scoped credential for the SAME account,
// which `POST /user/repos` cannot distinguish from an OAuth-issued one. The only thing
// faked is the token's PROVENANCE. Sanctioned by design-delta §10.2 (1448-1452), the
// same exception already used for YouVersion sign-in and OpenRouter PKCE, and BINDING
// per preflight §5a (decided by the user — not to be re-litigated).
//
// EVERYTHING PAST THAT HOP IS REAL: `POST https://api.github.com/user/repos` really
// creates a prefixed `…-jit-<runid>` repo in the installation account, with real
// name-collision 422s and real permission behaviour. The shim helper
// (`shimOnlyTheUserAuthorizationTokenExchange`) THROWS if asked for any other URL, so it
// structurally cannot drift into general-purpose stubbing.
//
// NOT PROVEN HERE, and deliberately not implied: the code-for-token exchange itself
// (redirect round-trip, `state` handling, `bad_verification_code`). That lives at unit
// level in `src/connections/github-user-auth-client.test.ts`, which is also where
// task-62 D18-2 landed — real GitHub returns HTTP **200** with
// `{"error":"bad_verification_code"}`, and the client now raises a typed
// `GithubUserAuthExchangeError` instead of an anonymous Zod parse failure.
//
// FIXED BY PLAN ROW 63 (was: "KNOWN PRODUCT GAP"). `createUserRepo` used to POST
// `{name, private}` with **no `auto_init`**, so the created repo had NO commits and no
// `main`, and `scaffold-project.ts`'s base PR (`base: "main"`) 422'd against real
// GitHub. The stub had masked it by claiming `default_branch: "main"` while a separate
// git-server fixture seeded an actual `main`. The api half of the fix is asserted right
// here — after the create, `GET /repos/:owner/:name/branches/main` must answer 200; the
// workflow half (an unborn-base-ref bootstrap, which is what fixes the
// existing-empty-repo path where there is no create call at all) is proven in
// `supagloo-nodejs-dbos/tests/e2e/scaffold-project.e2e.ts`. No `ProjectVersion` schema
// change was involved — `prNumber` was already nullable, and the base PR is preserved.
// This spec still uses the stand-in scaffold worker: it tests the api's JIT hop, not
// the workflow.
//
// ALSO FIXED HERE (DR1, the installation-visibility race). `createRepoAndProject` used
// to `POST /user/repos` and enqueue `scaffoldProjectWorkflow` in the very next
// statement, while the harness itself has gated on installation visibility since task 62
// (`waitForInstallationVisibility`, "Gate #2 before any workflow enqueue"). Under
// `repository_selection: "all"` a brand-new repo is covered by the installation but not
// INSTANTLY, and dbos's `ensureRepoReachable` calls absence PERMANENT — so the loser of
// that race got a job that went straight to `failed` (row 63's `markJobFailed`) next to
// a real, empty repo. The product now runs its own bounded gate, and the assertion below
// pins the resulting invariant with an installation token.
//
// This e2e never asserted stub counters (it predates that pattern by design), so
// nothing here needed the task-62 D9 counter reclassification. It asserts through the
// api's OWN observable effects: the 201 body, the created Project row, the job status.
//
// DURABLE SIDE EFFECTS: one private throwaway repo per successful create case, NEVER
// auto-removed (task-62 D6). Reclaim with the root repo's `npm run cleanup:github-e2e`.
//
// ISOLATION, NOT A PRECONDITION. This spec registers a STAND-IN `scaffoldProject` under
// the REAL shared name on the REAL shared `git-ops` queue. It never documented the
// assumption, but it had the same one the other three stand-in specs did: an idle Compose
// `dbos` service, because otherwise the containerised worker dequeues the delegated job
// and really scaffolds (or fails) it. That precondition is unsatisfiable across a full
// sweep — root's e2e lane and nextjs's render lane both bring `dbos` UP and leave it up.
// Instead the in-process runtime AND the enqueuer share a per-lane DBOS system SCHEMA
// inside the same `supagloo_dbos` database (SDK `systemDatabaseSchemaName`), so the two
// executors cannot see each other's rows in EITHER direction. The container may be up or
// down; both pass. The queue and workflow names are unchanged and deliberately still the
// real ones — exercising the real API↔DBOS name contract is the point of this spec.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const DBOS_URL =
  process.env.DBOS_DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";
const YOUVERSION_BASE =
  process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";
/** This lane's private DBOS system schema inside `supagloo_dbos` (see the header note). */
const SYSTEM_SCHEMA = laneSystemSchema("api_repo_prov");
const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const prisma: PrismaClient = createPrismaClient({ connectionString: APP_URL });

const doneStages = () =>
  buildInitialStages(SCAFFOLD_STAGES).map((s) => ({ ...s, state: "done" }));

// Stand-in scaffold worker: drive the app-DB row to succeeded (keyed by workflowID =
// jobId). No gates — the JIT e2e just needs the delegated create job to complete.
async function standInScaffoldFn(_payload: unknown): Promise<{ ok: true }> {
  const jobId = DBOS.workflowID!;
  await DBOS.runStep(
    async () => {
      await prisma.projectJob.updateMany({
        where: { id: jobId },
        data: {
          status: "succeeded",
          completedAt: new Date(),
          stages: doneStages() as any,
        },
      });
    },
    { name: "standInFinalize" },
  );
  return { ok: true };
}
DBOS.registerWorkflow(standInScaffoldFn, { name: SCAFFOLD_PROJECT_WORKFLOW_NAME });

let app: FastifyInstance;
let baseUrl: string;
let ctx: GithubE2eContext;
let oauthCreds: GithubOauthClientCreds;
/** Root's naming module — the ONE place the throwaway-repo prefix literal lives
 *  (task-62 D1). Never re-typed here: a throwaway repo whose name drifts from the
 *  cleanup script's hard gate would be unreclaimable. */
let naming: { buildE2eRepoName(slug: string, runId: string): string };
let enqueuer: {
  enqueue: (o: any, p: unknown) => Promise<void>;
  close: () => Promise<void>;
};
/** Minted ONCE (valid an hour) — the gate below polls with it many times per case. */
let installationToken: string;

const nextLink = (link: string | null): string | undefined => {
  for (const part of (link ?? "").split(",")) {
    const m = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/.exec(part);
    if (m) return m[1];
  }
  return undefined;
};

/**
 * Every repo full name the App INSTALLATION can reach — `GET /installation/repositories`
 * with a real installation token, following `Link: rel=next`.
 *
 * THIS IS THE VIEW THAT MATTERS: dbos's `ensureRepoReachable`
 * (`scaffold-project/github-rest.ts`) walks exactly this endpoint and treats absence as
 * a PERMANENT `RepoUnreachableError`, so it is what the product's visibility gate is
 * ultimately protecting.
 *
 * It is injected into `RepoProvisioningService` as the gate's lister, REPLACING the
 * production default (`GET /user/installations/:id/repositories` with the user token).
 * That substitution is forced, not a shortcut: the production endpoint requires a token
 * **authorized to the GitHub App**, and this lane fakes the user token's PROVENANCE with
 * a PAT — GitHub answers a classic `repo`-scoped PAT there with
 * `403 "You must authenticate with an access token authorized to a GitHub App…"`
 * (verified live against the real host). It is the SAME faked-provenance carve-out this
 * file's header already declares for the code→token exchange, showing up a second time
 * on the first endpoint that actually inspects provenance; the production lister itself
 * is unit-tested in `src/connections/github-user-auth-client.test.ts`. The substitution
 * makes this lane STRICTER, not laxer — it gates on dbos's own view rather than a proxy
 * for it.
 */
async function installationRepoFullNames(): Promise<string[]> {
  const out: string[] = [];
  let url: string | undefined =
    `${githubApiBaseUrl()}/installation/repositories?per_page=100`;
  for (let page = 1; url; page += 1) {
    if (page > 20) throw new Error("installation-repositories pagination guard tripped");
    const res: Response = await fetch(url, {
      headers: {
        authorization: `Bearer ${installationToken}`,
        accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) {
      throw new Error(
        `GET /installation/repositories failed: HTTP ${res.status} — ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { repositories?: { full_name: string }[] };
    for (const repo of body.repositories ?? []) out.push(repo.full_name);
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

beforeAll(async () => {
  // Fail FAST + LOUD on a missing credential / uninstalled App, before any DBOS or
  // Compose work. Never warn-and-skip (plan row 56 item 2).
  ctx = await resolveGithubE2eContext();
  oauthCreds = resolveGithubOauthClientCreds();
  naming = (await loadRootE2eHarness()).naming;

  // Self-heal a crashed previous run BEFORE launch, so no stale PENDING row is adopted
  // by DBOS's recovery sweep (same executor_id "local", same auto-computed app version).
  await resetLaneSchema({ systemDatabaseUrl: DBOS_URL, schema: SYSTEM_SCHEMA });

  DBOS.setConfig({
    name: "supagloo-api-repo-prov-e2e",
    systemDatabaseUrl: DBOS_URL,
    systemDatabaseSchemaName: SYSTEM_SCHEMA, // ← the runtime half
  });
  await DBOS.launch();
  await DBOS.registerQueue(GIT_OPS_QUEUE_NAME, { workerConcurrency: 4 });

  // Fail FAST and LOUD if the config did not take. Never a warn, never a skip.
  await assertLaneRuntimeIsolated({
    systemDatabaseUrl: DBOS_URL,
    schema: SYSTEM_SCHEMA,
  });

  enqueuer = makeDbosEnqueuer({
    systemDatabaseUrl: DBOS_URL,
    systemDatabaseSchemaName: SYSTEM_SCHEMA, // ← the enqueuer half
  });

  const authService = new AuthService({
    prisma,
    verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
    sessionTtlMs: SESSION_TTL_MS,
  });
  const projectsService = new ProjectsService({ prisma });
  const jobsService = new ProjectJobsService({
    prisma,
    enqueue: enqueuer.enqueue,
  });
  const userAuthClient = makeGithubUserAuthClient({
    // The stub served BOTH hosts off one port; real GitHub splits them. The OAuth host
    // is where the (shimmed) exchange lives; the API host is fully real.
    oauthBaseUrl: githubOauthBaseUrl(),
    apiBaseUrl: githubApiBaseUrl(),
    clientId: oauthCreds.clientId,
    clientSecret: oauthCreds.clientSecret,
    fetchImpl: shimOnlyTheUserAuthorizationTokenExchange(fetch, ctx.pat),
  });
  installationToken = await mintE2eInstallationToken();
  const repoProvisioningService = new RepoProvisioningService({
    prisma,
    userAuthClient,
    createProject: (userId, req) =>
      jobsService.createProjectWithScaffold(userId, req),
    // The DR1 visibility gate, reading dbos's own view — see
    // `installationRepoFullNames` for why the production default cannot be used here.
    // Everything else about the gate (deadline, backoff, failure mode) is the product's.
    listInstallationRepos: installationRepoFullNames,
  });

  app = buildApp({
    auth: {
      authService,
      env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
    },
    projects: { service: projectsService },
    projectJobs: { service: jobsService },
    repoProvisioning: { service: repoProvisioningService },
  });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  await enqueuer?.close().catch(() => {});
  await DBOS.shutdown();
  await prisma.$disconnect().catch(() => {});
});

async function seedUser(tag: string): Promise<{ token: string; userId: string }> {
  const s = stamp();
  const token = `repoprov-e2e-${tag}-${s}`;
  const res = await fetch(`${baseUrl}/v1/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      users: [
        {
          youversionUserId: `yv-repoprov-${tag}-${s}`,
          displayName: `RepoProv E2E ${tag}`,
          email: `repoprov-${tag}-${s}@example.test`,
          avatarInitials: "RP",
          sessionToken: token,
        },
      ],
    }),
  });
  const body = await res.json();
  return { token, userId: body.users[0].user.id };
}

/**
 * Connect with the DISCOVERED installation id, login and `repositorySelection` — never
 * the fabricated `installationId: "42"` / `githubLogin: "acme"`.
 *
 * The live installation is `repository_selection: "all"`, so
 * `RepoProvisioningService` correctly SKIPS `addRepoToInstallation`
 * (repo-provisioning-service.ts:96). That is not a coverage hole: real GitHub 422s a
 * repository-access-list edit under an all-repos install, so the `"selected"` branch is
 * unreachable here by construction and is covered at unit level instead
 * (`github-user-auth-client.test.ts`, task-62 D13).
 */
async function connectGithub(userId: string): Promise<void> {
  await seedGithubConnection(prisma, userId);
}

const api = (
  path: string,
  token?: string,
  init: { method?: string; body?: unknown } = {},
) =>
  fetch(`${baseUrl}/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

async function pollUntilStatus(
  token: string,
  projectId: string,
  jobId: string,
  status: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(`/projects/${projectId}/jobs/${jobId}`, token);
    if (res.status === 200) {
      const { job } = await res.json();
      if (job.status === status) return job;
    }
    await sleep(150);
  }
  throw new Error(`job ${jobId} did not reach ${status} within ${timeoutMs}ms`);
}

describe("e2e: GET /v1/projects/repo-authorize-url", () => {
  it("returns the GitHub user-authorization URL with client_id, redirect_uri, scope, state", async () => {
    const owner = await seedUser("authurl");
    const redirectUri = "http://localhost:3000/connect/github/create-repo/callback";
    const res = await api(
      `/projects/repo-authorize-url?redirectUri=${encodeURIComponent(redirectUri)}&state=nonce-xyz`,
      owner.token,
    );
    expect(res.status).toBe(200);
    const { url } = await res.json();
    const parsed = new URL(url);
    // The URL a real user's browser would actually be sent to — no stub host, and the
    // REAL App client id (task-62 D13 / preflight §5a).
    expect(parsed.origin + parsed.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe(oauthCreds.clientId);
    expect(parsed.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(parsed.searchParams.get("scope")).toBe("repo");
    expect(parsed.searchParams.get("state")).toBe("nonce-xyz");
  });

  it("401s without a bearer token", async () => {
    expect(
      (await api("/projects/repo-authorize-url?redirectUri=http://x&state=y")).status,
    ).toBe(401);
  });
});

describe("e2e: POST /v1/projects/create-repo — the JIT hop → scaffold", () => {
  it("E-RP0: the repo-provisioning lane runs on its own DBOS system schema, so the Compose worker cannot see its work", async () => {
    expect(SYSTEM_SCHEMA).not.toBe("dbos");
    await assertLaneRuntimeIsolated({
      systemDatabaseUrl: DBOS_URL,
      schema: SYSTEM_SCHEMA,
    });
  });

  it("exchanges the code, creates the repo, and scaffolds it to succeeded", async () => {
    const owner = await seedUser("create");
    await connectGithub(owner.userId);
    // A prefixed, per-run name so the durable artifact this test leaves behind is
    // unmistakably a throwaway and is reclaimable by the cleanup script's hard gate.
    const repoName = naming.buildE2eRepoName("jit", ctx.runId);

    const created = await api("/projects/create-repo", owner.token, {
      method: "POST",
      body: {
        // Any non-empty code: the exchange is the one shimmed hop, and the real
        // `bad_verification_code` path is unit-tested instead (preflight §5a).
        code: "shimmed-user-authorization-code",
        name: "Psalm JIT",
        repoName,
        visibility: "private",
        createdFrom: "blank",
      },
    });
    expect(created.status).toBe(201);
    const { projectId, jobId } = await created.json();
    expect(projectId).toBeTruthy();
    expect(jobId).toBeTruthy();

    // The ENQUEUER half of the isolation is real: the delegated job landed in this lane's
    // schema and is absent from the shared one the Compose worker polls.
    //
    // ORDERING IS LOAD-BEARING — this runs here, immediately after the 201, and not
    // beside the job poll further down. `POST /projects/create-repo` awaits the enqueue
    // before it answers, so the row is committed by now and this needs no polling.
    // Sequenced later, a dropped `systemDatabaseSchemaName` on the enqueuer surfaces as a
    // bare poll timeout (measured in project-jobs.e2e.ts) that names neither the cause nor
    // the remedy — and only after this spec has already spent several real-GitHub round
    // trips. Here it fails in milliseconds, with the remedy named.
    await assertWorkflowIsolated({
      systemDatabaseUrl: DBOS_URL,
      schema: SYSTEM_SCHEMA,
      workflowID: jobId,
    });

    // The created Project points at the owner GITHUB assigned (echoed back by
    // `POST /user/repos`, i.e. the discovered account) and the requested repo name —
    // proving the repo was created via the user token, not supplied by the client.
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    expect(project?.repoOwner).toBe(ctx.owner);
    expect(project?.repoName).toBe(repoName);
    expect(project?.createdFrom).toBe("blank");

    // ----------------------------------------------------------------- plan row 63
    // The api owns repo SHAPE at creation (design-delta §7:1082-1093 — repo creation
    // happens before the workflow), so the repo it just created must already have a
    // real `main`. Without `auto_init: true` this GET is a 404 and every downstream
    // `base: "main"` PR 422s. Read with the PAT: the installation may not have picked
    // the brand-new repo up yet, and this assertion is about GitHub's state, not the
    // installation's view of it.
    const branchRes = await fetch(
      `${githubApiBaseUrl()}/repos/${ctx.owner}/${repoName}/branches/main`,
      {
        headers: {
          authorization: `token ${ctx.pat}`,
          accept: "application/vnd.github+json",
        },
      },
    );
    expect(branchRes.status).toBe(200);

    // ------------------------------------------------------------------------ DR1
    // The invariant the installation-visibility gate exists to establish, asserted with
    // the credential PRODUCTION actually holds (an installation token, minted with the
    // product primitive) rather than the PAT: by the time `POST /projects/create-repo`
    // answers 201, the App installation can already reach the new repo. An installation
    // token is scoped to the installation's repositories, so a repo it cannot yet see
    // answers 404 — which is precisely the state dbos's `ensureRepoReachable` turns into
    // a PERMANENT `RepoUnreachableError` (no DBOS retry, job straight to `failed`).
    //
    // DELIBERATELY UNRETRIED. Every other real-host read in this suite gets a bounded
    // retry because GitHub's indexes are eventually consistent; this one must NOT, or it
    // would re-introduce the very wait it is checking for and go green whether or not
    // the product waited. Its determinism IS the assertion — before the gate existed,
    // this line is exactly what would have been intermittently red.
    expect(await installationRepoFullNames()).toContain(`${ctx.owner}/${repoName}`);

    // The delegated scaffold job runs to completion (stand-in worker).
    const done = await pollUntilStatus(owner.token, projectId, jobId, "succeeded");
    expect(done.stages.every((s: any) => s.state === "done")).toBe(true);
    // Timeout budget: the create itself is seconds, but the product's visibility gate is
    // allowed up to 60 s (harness parity) before it gives up, and the job poll another 15.
  }, 120_000);

  it("409 github_not_connected when the user has no GitHub connection", async () => {
    const owner = await seedUser("noconn");
    const res = await api("/projects/create-repo", owner.token, {
      method: "POST",
      body: {
        code: "gh-user-auth-code",
        repoName: `psalm-noconn-${stamp()}`,
        visibility: "private",
        createdFrom: "blank",
      },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("github_not_connected");
  });

  it("401s without a bearer token", async () => {
    expect(
      (
        await api("/projects/create-repo", undefined, {
          method: "POST",
          body: {
            code: "c",
            repoName: "r",
            visibility: "private",
            createdFrom: "blank",
          },
        })
      ).status,
    ).toBe(401);
  });
});
