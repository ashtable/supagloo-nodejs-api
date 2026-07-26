import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPrismaClient, type PrismaClient } from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { makeYouVersionVerifier } from "../../src/auth/youversion";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { makeGithubAppClient } from "../../src/connections/github-app-client";
import { GithubConnectionService } from "../../src/connections/github-connection-service";
import {
  githubApiBaseUrl,
  githubOauthBaseUrl,
  provisionFixtureRepo,
  resolveGithubE2eContext,
  type FixtureRepo,
  type GithubE2eContext,
} from "../../src/testing/github-e2e";

// Non-UI e2e for the GitHub App connection (Task #11), REPOINTED AT REAL GITHUB in
// task-62 (design-delta §11). Boots the REAL Fastify app in-process (real listen + real
// fetch) wired to REAL Postgres (Compose `supagloo` DB) and to **real
// api.github.com** — there is no github-stub any more, and no fabricated fixture
// account. Infra ensured by tests/e2e/global-setup.ts (Postgres + MinIO); GitHub needs
// no service, only the root `.env` credentials.
//
// What changed, and why each change makes the proof STRONGER (design-delta §11.5):
//
//   • The App JWT is signed with the REAL App private key (`GITHUB_APP_ID` +
//     `GITHUB_APP_PRIVATE_KEY`), not a throwaway keypair + `appId: "123456"`. A
//     throwaway keypair can only ever prove "we produced a syntactically valid JWT";
//     the real key proves GitHub ACCEPTS it — which is exactly row 62 item (c)'s bug
//     class (an escaped-`\n` PEM that signed fine and 401ed on the wire).
//
//   • `installationId` is DISCOVERED at runtime (`GET /app/installations`), never the
//     fabricated `"42"`, and `githubLogin` is the discovered account login, never
//     `"acme"`. Row 62 item (d) was precisely this: real GitHub correctly 404s
//     `POST /app/installations/42/access_tokens`. Installation ids change on reinstall,
//     so hardcoding one guarantees a future red run (task-62 D5).
//
//   • The "fresh token per request" CALL-COUNT assertions are GONE from here. They read
//     the stub's `/__stub/calls` counter after a `/__stub/reset`; real GitHub exposes no
//     per-caller counter, so there is no analogue. They are not weakened — they are
//     RECLASSIFIED to `src/connections/github-app-client.test.ts` with an injected
//     COUNTING fetchImpl, which attributes each HTTP call to the method that made it
//     instead of to a shared container (task-62 D9). What the e2e gains instead is a
//     REAL pagination proof the stub's 4-repo fixture could never give.
//
//   • `filter=empty` / `q=` no longer lean on a fabricated 4-repo account
//     (`acme/empty-one|empty-two|psalms-video|genesis-app`). They are STRUCTURAL against
//     this run's own throwaway repo. The exhaustive filter matrix stays where it belongs,
//     in `src/connections/repo-filter.test.ts`.
//
// DURABLE SIDE EFFECTS: this spec creates ONE private throwaway repo per run in the
// installation's account, named by root's `buildE2eRepoName(slug, runId)`. It is NEVER
// auto-deleted or auto-archived (task-62 D6): reclaim it with the root repo's
// interactive, archive-only `npm run cleanup:github-e2e`.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";
const YOUVERSION_BASE =
  process.env.YOUVERSION_BASE_URL ?? "https://api.youversion.com";

describe("e2e: GitHub App connection (real github.com)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let baseUrl: string;
  let ctx: GithubE2eContext;
  let fixture: FixtureRepo;

  beforeAll(async () => {
    // Fail FAST + LOUD on a missing credential / uninstalled App: names the var, the
    // root `.env`, and (for a zero-installation account)
    // https://github.com/apps/supagloo/installations/new. This THROWS — a
    // console.warn + skip would be invisible under `npm run test:e2e` (plan row 56
    // item 2) and would turn missing GitHub coverage into a green lie.
    ctx = await resolveGithubE2eContext();

    prisma = createPrismaClient({ connectionString: APP_URL });

    const authService = new AuthService({
      prisma,
      verifyToken: makeYouVersionVerifier({ baseUrl: YOUVERSION_BASE }),
      sessionTtlMs: SESSION_TTL_MS,
    });

    const appClient = makeGithubAppClient({
      apiBaseUrl: githubApiBaseUrl(),
      appId: ctx.appId,
      privateKey: ctx.privateKey,
    });
    const githubService = new GithubConnectionService({
      prisma,
      verifyInstallation: appClient.verifyInstallation,
      listInstallationRepos: appClient.listInstallationRepos,
      oauthBaseUrl: githubOauthBaseUrl(),
      appSlug: ctx.appSlug,
    });

    app = buildApp({
      auth: {
        authService,
        env: { NODE_ENV: "test", SUPAGLOO_ENABLE_TEST_SEED: "1" },
      },
      github: { service: githubService },
    });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

    // ONE throwaway repo shared by every listing assertion in this file (task-62 D7:
    // repo creation falls under GitHub's secondary/abuse limits, so the creation
    // budget is minimised by sharing per spec file wherever the workflow permits).
    fixture = await provisionFixtureRepo("ghconn", {
      spec: "supagloo-nodejs-api/tests/e2e/github-connection.e2e.ts",
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    // NO teardown of the fixture repo, deliberately (task-62 D6): reclamation is the
    // root repo's interactive `npm run cleanup:github-e2e`, and a red run almost always
    // needs the repo left in place to diagnose.
  });

  // Seed a fresh user + session; returns the bearer token + userId.
  async function seedUser(): Promise<{ token: string; userId: string }> {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const token = `gh-e2e-${stamp}`;
    const res = await fetch(`${baseUrl}/v1/test/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        users: [
          {
            youversionUserId: `yv-gh-${stamp}`,
            displayName: "GH E2E",
            email: `gh-${stamp}@example.test`,
            avatarInitials: "GH",
            sessionToken: token,
          },
        ],
      }),
    });
    const body = await res.json();
    return { token, userId: body.users[0].user.id };
  }

  const authed = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  /** Connect the seeded user with the DISCOVERED installation id, through the app's
   *  OWN real callback route (which performs a real App-JWT-authenticated
   *  `GET /app/installations/:id` against api.github.com). */
  async function connect(token: string): Promise<Response> {
    return authed("POST", "/v1/connections/github/callback", token, {
      installationId: ctx.installationId,
    });
  }

  it("install-url returns the hosted picker URL and requires auth", async () => {
    const { token } = await seedUser();

    const noAuth = await fetch(`${baseUrl}/v1/connections/github/install-url`);
    expect(noAuth.status).toBe(401);

    const res = await authed("GET", "/v1/connections/github/install-url", token);
    expect(res.status).toBe(200);
    const { url } = await res.json();
    // Built from the REAL app slug + the real OAuth host — the URL a user would
    // actually be sent to, not a stub-shaped one.
    expect(url).toBe(
      `https://github.com/apps/${ctx.appSlug}/installations/new`,
    );
  });

  it("callback verifies against REAL GitHub via App JWT and stores ONLY installationId + githubLogin (no token column)", async () => {
    const { token, userId } = await seedUser();

    const res = await connect(token);
    expect(res.status).toBe(200);
    const { connection } = await res.json();
    expect(connection.installationId).toBe(ctx.installationId);
    // The login comes back from GitHub itself; asserting it equals the DISCOVERED
    // owner proves the round-trip, without hardcoding any account name.
    expect(connection.githubLogin).toBe(ctx.owner);
    expect(["all", "selected"]).toContain(connection.repositorySelection);
    expect(connection.repositorySelection).toBe(ctx.repositorySelection);
    expect(connection.status).toBe("connected");

    // Read the row straight from Postgres: only the 6 design columns, no token.
    const row = (await prisma.githubConnection.findUnique({
      where: { userId },
    })) as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(new Set(Object.keys(row!))).toEqual(
      new Set([
        "userId",
        "githubLogin",
        "installationId",
        "repositorySelection",
        "status",
        "connectedAt",
      ]),
    );
    expect(Object.keys(row!).join(",")).not.toMatch(/token|ciphertext|secret/i);
  });

  it("callback 400s for an installation id that does not exist on real GitHub", async () => {
    // The stub answered ANY installation id, so this path was never exercised. Real
    // GitHub 404s an unknown id, which the client maps to `null` and the service to a
    // typed verification failure → 400. This is row 62 item (d)'s failure mode,
    // asserted as the CORRECT behaviour rather than discovered as a mystery.
    const { token } = await seedUser();
    const res = await authed(
      "POST",
      "/v1/connections/github/callback",
      token,
      { installationId: "1" },
    );
    expect(res.status).toBe(400);
  });

  it("repos walks the REAL Link: rel=next pagination without truncating or duplicating", async () => {
    // The proof the stub's 4-repo fixture could never give. Under
    // `repository_selection: all` the installation sees the whole account, which has
    // well over one page of repos, so `parseNextLink`
    // (github-app-client.ts:96-100) is genuinely exercised.
    const { token } = await seedUser();
    expect((await connect(token)).status).toBe(200);

    const res = await authed("GET", "/v1/github/repos?filter=all", token);
    expect(res.status).toBe(200);
    const { repositories } = await res.json();

    expect(Array.isArray(repositories)).toBe(true);
    expect(repositories.length).toBeGreaterThan(0);

    // (1) No duplicates. A `Link` walk that re-follows the same URL, or that mistakes
    // `rel="last"` for `rel="next"`, shows up here as repeated ids.
    const ids = repositories.map((r: { id: number }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    // (2) NO TRUNCATION: this run's fixture repo — created seconds ago and therefore
    // in no fixed page position — must be present in the unfiltered listing. A walk
    // that stops after page 1 loses repos silently, which is the actual product bug
    // (the user's target repo simply absent from the picker, with no error).
    expect(repositories.map((r: { name: string }) => r.name)).toContain(
      fixture.repo,
    );

    // Deliberately NOT asserted here: "more than one HTTP page was fetched". The live
    // account's repo count is not a property this suite may pin (it is the user's real
    // account, and any assertion of the form `length > 100` / `length % 100 !== 0`
    // would be either brittle or outright wrong for a legitimately full last page).
    // The page-walk MECHANICS are proven deterministically in
    // `src/connections/github-app-client.test.ts` ("follows Link rel=next pagination
    // and returns the union of every page"). What this e2e adds is that the walk works
    // against real GitHub's real headers and loses nothing.

    // (3) Every row is the mapped DTO shape, and the owner is the discovered login.
    for (const repo of repositories) {
      expect(typeof repo.fullName).toBe("string");
      expect(repo.fullName).toBe(`${repo.owner}/${repo.name}`);
      expect(typeof repo.empty).toBe("boolean");
    }
  });

  it("filter=empty and q= narrow the live listing down to THIS run's fixture repo", async () => {
    const { token } = await seedUser();
    expect((await connect(token)).status).toBe(200);

    // The fixture's full name carries the prefix, this spec's slug AND the per-run id,
    // so querying it isolates exactly one repo — structural, with no dependence on what
    // else the account happens to contain. (Querying the bare run id would NOT be safe:
    // sibling spec files in the same worker process share one `E2E_RUN_ID`, so several
    // of this run's fixture repos would match.)
    const q = await (
      await authed(
        "GET",
        `/v1/github/repos?filter=all&q=${encodeURIComponent(fixture.repo)}`,
        token,
      )
    ).json();
    expect(q.repositories.map((r: { name: string }) => r.name)).toEqual([
      fixture.repo,
    ]);

    // The same repo must ALSO be reachable under `filter=empty` — this is the
    // product-level gate on `github-app-client.ts`'s `empty = size === 0` derivation
    // (task-62 D16). GitHub reports `size` in KB and computes it ASYNCHRONOUSLY, so a
    // just-created `auto_init` repo (one small README commit) lists as size 0.
    // IF THIS GOES RED: the derivation, not this assertion, is what is wrong — see
    // design-delta §10.4a ("if reality differs, the client changes, not the tests")
    // and plan row N3, which specifies the contingency (treat `size > 0` as definitive
    // not-empty and probe `GET /repos/:o/:r/commits?per_page=2` only for the ambiguous
    // `size === 0` subset). Do NOT relax this assertion instead.
    const empty = await (
      await authed(
        "GET",
        `/v1/github/repos?filter=empty&q=${encodeURIComponent(fixture.repo)}`,
        token,
      )
    ).json();
    expect(empty.repositories.map((r: { name: string }) => r.name)).toEqual([
      fixture.repo,
    ]);
    expect(empty.repositories[0].empty).toBe(true);
    expect(empty.repositories[0].private).toBe(true);
    expect(empty.repositories[0].defaultBranch).toBe("main");
    expect(empty.repositories[0].owner).toBe(ctx.owner);

    // And a query that matches nothing returns an empty list, not everything.
    const none = await (
      await authed(
        "GET",
        `/v1/github/repos?filter=all&q=${encodeURIComponent(`no-such-repo-${fixture.repo}`)}`,
        token,
      )
    ).json();
    expect(none.repositories).toEqual([]);
  });

  it("listing repos before connecting GitHub returns 409", async () => {
    const { token } = await seedUser();
    const res = await authed("GET", "/v1/github/repos?filter=all", token);
    expect(res.status).toBe(409);
  });

  it("disconnect removes the row and is idempotent", async () => {
    const { token, userId } = await seedUser();
    expect((await connect(token)).status).toBe(200);

    const del = await authed("DELETE", "/v1/connections/github", token);
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);
    expect(
      await prisma.githubConnection.findUnique({ where: { userId } }),
    ).toBeNull();

    // Second delete still succeeds (idempotent).
    const again = await authed("DELETE", "/v1/connections/github", token);
    expect(again.status).toBe(200);
  });
});
