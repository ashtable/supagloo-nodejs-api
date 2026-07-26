import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { DEFAULT_GITHUB_MAX_ATTEMPTS } from "@supagloo/database-lib";
import {
  makeGithubAppClient,
  makeInteractiveGithubAppClient,
  EMPTINESS_PROBE_CONCURRENCY,
  INTERACTIVE_GITHUB_MAX_ATTEMPTS,
  INTERACTIVE_GITHUB_RETRY_BUDGET_MS,
  GithubAppRequestError,
} from "./github-app-client";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import {
  registerGithubConnectionRoutes,
  registerGithubRepoRoutes,
} from "../routes/github";
import { registerManifestRoutes } from "../routes/manifests";

// The GitHub App HTTP client (design-delta §2.3/§6a). Mirrors youversion.ts:
// injectable fetch, unit-tested with hand-built Response objects (no mocking
// library). It wraps db-lib's signAppJwt + mintInstallationToken:
//   - verifyInstallation → GET /app/installations/:id with an APP JWT.
//   - listInstallationRepos → mint an installation token, then GET
//     /installation/repositories with THAT token (never cached/stored).

const { privateKey: PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP_ID = "123456";

function recordingFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
) {
  const calls: { url: string; auth?: string; method?: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      auth: headers.get("authorization") ?? undefined,
      method: init?.method ?? "GET",
    });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const isJwt = (tok: string) => tok.split(".").length === 3;

/**
 * "I will read `empty` on every row" — the caller intent plan row 65's probe now
 * requires (deferred review finding DR2: the probe is opt-in, because
 * `GET /v1/github/repos` also serves a per-page-load repo COUNT that never reads it).
 *
 * Every probe test below passes this DELIBERATELY rather than relying on a default, so
 * none of them can quietly become vacuous: without it there is no probe to assert on,
 * and a test that asserts "no probe" would then pass for the wrong reason.
 */
const PROBE_ALL = () => true;

describe("makeGithubAppClient.verifyInstallation", () => {
  it("GETs /app/installations/:id with an App JWT and maps the result", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 42,
            account: { login: "acme" },
            repository_selection: "selected",
          }),
          { status: 200 },
        ),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    const result = await client.verifyInstallation("42");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/app/installations/42");
    expect(calls[0].auth?.startsWith("Bearer ")).toBe(true);
    expect(isJwt(calls[0].auth!.slice("Bearer ".length))).toBe(true);
    expect(result).toEqual({ githubLogin: "acme", repositorySelection: "selected" });
  });

  it("returns null on a 404 (installation not found)", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });
    expect(await client.verifyInstallation("999")).toBeNull();
  });

  it("throws on an unexpected upstream error (5xx), carrying the upstream status", async () => {
    // plan row 64: a 5xx is retryable, so this now exercises the bounded backoff too —
    // hence the INJECTED sleep (the unit lane must never actually wait, §10.6). The
    // thrown error carries `upstreamStatus` so a caller can classify it without
    // re-parsing the message; see the class doc-comment for why it is NOT named
    // `status` (Fastify would hijack it into the reply code).
    const sleeps: number[] = [];
    const { fetchImpl, calls } = recordingFetch(
      () => new Response("boom", { status: 500 }),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    const err = await client
      .verifyInstallation("42")
      .then(() => null, (e: unknown) => e as GithubAppRequestError);
    expect(err).toBeInstanceOf(GithubAppRequestError);
    expect(err?.upstreamStatus).toBe(500);
    expect(err?.statusCode).toBe(502);
    expect(calls).toHaveLength(DEFAULT_GITHUB_MAX_ATTEMPTS);
    expect(sleeps).toEqual([500, 1_000, 2_000]);
  });

  it("normalizes an escaped-newline PEM before signing", async () => {
    const escaped = PRIVATE_KEY.replace(/\n/g, "\\n");
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ id: 42, account: { login: "acme" }, repository_selection: "all" }),
          { status: 200 },
        ),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: escaped,
      fetchImpl,
    });
    // Must not throw: the escaped PEM is restored to a real key before signing.
    await client.verifyInstallation("42");
    expect(isJwt(calls[0].auth!.slice("Bearer ".length))).toBe(true);
  });
});

describe("makeGithubAppClient.listInstallationRepos", () => {
  it("mints an installation token then lists with it, mapping size→empty", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_minted_1",
            expires_at: "2026-07-18T13:00:00.000Z",
          }),
          { status: 201 },
        );
      }
      // plan row 65: `empty-one` is `size: 0`, so it is a probe CANDIDATE, not a
      // verdict. One commit ⇒ still empty (the `auto_init` README shape), so the
      // `size→empty` mapping this test names is preserved — now for the right reason.
      if (url.endsWith("/commits?per_page=2")) {
        return new Response(JSON.stringify([{ sha: "readme" }]), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          total_count: 2,
          repositories: [
            {
              id: 101,
              name: "empty-one",
              full_name: "acme/empty-one",
              owner: { login: "acme" },
              private: true,
              default_branch: "main",
              size: 0,
            },
            {
              id: 103,
              name: "psalms-video",
              full_name: "acme/psalms-video",
              owner: { login: "acme" },
              private: false,
              default_branch: "main",
              size: 512,
            },
          ],
        }),
        { status: 200 },
      );
    });
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    const repos = await client.listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    // First mint (App JWT), then list (minted installation token).
    expect(calls[0].url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(calls[0].auth?.startsWith("Bearer ")).toBe(true);
    expect(isJwt(calls[0].auth!.slice("Bearer ".length))).toBe(true);

    // The listing now requests GitHub's max page size (per_page=100); with no
    // `Link: rel="next"` on this single-page response the client stops here.
    expect(calls[1].url).toBe(
      "https://api.github.com/installation/repositories?per_page=100",
    );
    expect(calls[1].auth).toContain("ghs_minted_1");

    // ENDPOINT-SCOPED counts, not a bare total (plan row 65 / D65.6). The bare
    // `expect(calls).toHaveLength(2)` that stood here was a HARD BREAK the moment the
    // emptiness probe landed, and a bare total tells you nothing about WHICH request
    // moved. The budget is: 1 mint + 1 listing GET + 1 probe (for the single
    // `size: 0` candidate) — and NOTHING else.
    const byEndpoint = (needle: string) =>
      calls.filter((c) => c.url.includes(needle)).length;
    expect(byEndpoint("/access_tokens")).toBe(1);
    expect(byEndpoint("/installation/repositories")).toBe(1);
    expect(byEndpoint("/commits?per_page=2")).toBe(1);
    expect(calls).toHaveLength(3);
    // Exactly ONE probe, for `empty-one` only — `psalms-video` is `size: 512` and is
    // short-circuited as definitively not empty without any request.
    expect(calls[2].url).toBe(
      "https://api.github.com/repos/acme/empty-one/commits?per_page=2",
    );
    expect(calls[2].auth).toContain("ghs_minted_1");

    expect(repos).toEqual([
      {
        id: 101,
        name: "empty-one",
        fullName: "acme/empty-one",
        owner: "acme",
        private: true,
        defaultBranch: "main",
        empty: true,
      },
      {
        id: 103,
        name: "psalms-video",
        fullName: "acme/psalms-video",
        owner: "acme",
        private: false,
        defaultBranch: "main",
        empty: false,
      },
    ]);
  });

  it("follows Link rel=\"next\" pagination and returns the union of every page", async () => {
    // GET /installation/repositories is paginated (default 30, max 100 per_page).
    // A single unpaginated fetch silently truncates any installation with more
    // repos than one page — a user's target repo vanishing from the picker. The
    // client must request per_page=100 and follow `Link: rel="next"` to exhaustion.
    const repo = (id: number, name: string, size: number, priv: boolean) => ({
      id,
      name,
      full_name: `acme/${name}`,
      owner: { login: "acme" },
      private: priv,
      default_branch: "main",
      size,
    });

    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_minted_1",
            expires_at: "2026-07-18T13:00:00.000Z",
          }),
          { status: 201 },
        );
      }
      // plan row 65: both `size: 0` repos on page 1 are probe candidates. Answered
      // EXPLICITLY here — without this branch the probe URL would fall through to the
      // listing handler and be "answered" by a page-1 body, which the probe rejects as
      // unparseable and silently falls back on. This test would still pass, for
      // entirely the wrong reason.
      if (url.endsWith("/commits?per_page=2")) {
        return new Response(JSON.stringify([{ sha: "readme" }]), { status: 200 });
      }
      const page = new URL(url).searchParams.get("page") ?? "1";
      if (page === "1") {
        // A full first page + a `rel="next"` link to page 2 (and a `rel="last"`,
        // which the client must ignore in favour of following `next`).
        return new Response(
          JSON.stringify({
            total_count: 3,
            repositories: [
              repo(101, "empty-one", 0, true),
              repo(102, "empty-two", 0, false),
            ],
          }),
          {
            status: 200,
            headers: {
              link:
                '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next", ' +
                '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="last"',
            },
          },
        );
      }
      // Last page: no `rel="next"` ⇒ the loop terminates here.
      return new Response(
        JSON.stringify({
          total_count: 3,
          repositories: [repo(103, "psalms-video", 512, false)],
        }),
        { status: 200 },
      );
    });

    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    const repos = await client.listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    // The UNION of both pages, in order — not just the first page.
    expect(repos.map((r) => r.id)).toEqual([101, 102, 103]);

    // The client actually issued multiple HTTP requests (didn't trust one page).
    const repoCalls = calls.filter((c) =>
      c.url.includes("/installation/repositories"),
    );
    expect(repoCalls).toHaveLength(2);
    // It asked for the max page size on the first request.
    expect(repoCalls[0].url).toContain("per_page=100");
    // Exactly ONE token minted for the whole listing, reused across pages.
    const mintCalls = calls.filter((c) => c.url.endsWith("/access_tokens"));
    expect(mintCalls).toHaveLength(1);
    for (const c of repoCalls) expect(c.auth).toContain("ghs_minted_1");

    // plan row 65: the probe runs AFTER the whole page walk, over the union — two
    // `size: 0` candidates (101, 102), never the `size: 512` one (103) — and rides
    // the same single minted token. One request per candidate, no re-mint.
    const probeCalls = calls.filter((c) => c.url.endsWith("/commits?per_page=2"));
    expect(probeCalls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/empty-one/commits?per_page=2",
      "https://api.github.com/repos/acme/empty-two/commits?per_page=2",
    ]);
    for (const c of probeCalls) expect(c.auth).toContain("ghs_minted_1");
    expect(repos.map((r) => r.empty)).toEqual([true, true, false]);
  });
});

// ===========================================================================
// plan row 65 — the EMPTINESS PROBE (D65.2 / D65.3).
//
// `empty` used to be `size === 0` alone. GitHub reports `size` in KB and computes
// it ASYNCHRONOUSLY, so it lags UPWARD: it can read 0 for a repo that already has
// content, but it never overstates. The realistic defect is therefore a false
// `empty: true` — the wizard offering an already-populated repo as a scaffold
// target with its `data-disabled` gate lifted.
//
// The implemented rule (task-62 D16, verbatim):
//   • `size > 0`  ⇒ definitively NOT empty, and NO probe is issued.
//   • `size === 0` ⇒ probe `GET /repos/:o/:r/commits?per_page=2`:
//        409 ("Git Repository is empty")  ⇒ empty
//        200 with ≤1 commit               ⇒ empty   ← the `auto_init` README case
//        200 with ≥2 commits              ⇒ NOT empty
//        anything else                    ⇒ unknown ⇒ fall back to `size === 0`
//   • the probe fan-out is bounded by EMPTINESS_PROBE_CONCURRENCY.
//
// The "≤1 commit ⇒ empty" half is NOT an accident: plan row 65's own wording
// ("a non-empty REF LIST means not empty") would flip every `auto_init` fixture
// repo in the system to `empty: false`, which breaks
// `tests/e2e/github-connection.e2e.ts` and disables the picker row that is the
// SOLE project-acquisition path for the whole nextjs `test:e2e:real` lane.
// ===========================================================================

const PROBE_SUFFIX = "/commits?per_page=2";
const isProbe = (url: string) => url.endsWith(PROBE_SUFFIX);

type RawRepo = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  size: number;
};

const rawRepo = (id: number, name: string, size: number): RawRepo => ({
  id,
  name,
  full_name: `acme/${name}`,
  owner: { login: "acme" },
  private: true,
  default_branch: "main",
  size,
});

const listingResponse = (repos: RawRepo[]) =>
  new Response(
    JSON.stringify({ total_count: repos.length, repositories: repos }),
    { status: 200 },
  );

/** One element of `GET /repos/:o/:r/commits` — only the array LENGTH is read. */
const commitEntry = (sha: string) => ({ sha, commit: { message: sha } });

describe("plan row 65: listInstallationRepos emptiness probe", () => {
  const build = (fetchImpl: typeof fetch) =>
    makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

  it("does NOT report a size:0 repo with >=2 commits as empty", async () => {
    // The whole point of the row: GitHub's `size` is asynchronous, so a repo with
    // real content can still list as `size: 0` inside the async window.
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(
          JSON.stringify([commitEntry("aaa"), commitEntry("bbb")]),
          { status: 200 },
        );
      }
      return listingResponse([rawRepo(101, "two-commits", 0)]);
    });

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    expect(repos.map((r) => r.name)).toEqual(["two-commits"]);
    expect(repos[0].empty).toBe(false);
  });

  it("reports a size:0 repo as empty when the commits probe 409s with 'Git Repository is empty'", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(
          JSON.stringify({
            message: "Git Repository is empty.",
            documentation_url:
              "https://docs.github.com/rest/commits/commits#list-commits",
            status: "409",
          }),
          { status: 409 },
        );
      }
      return listingResponse([rawRepo(101, "unborn", 0)]);
    });

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    expect(repos[0].empty).toBe(true);
    const probes = calls.filter((c) => isProbe(c.url));
    expect(probes).toHaveLength(1);
    expect(probes[0].url).toBe(
      "https://api.github.com/repos/acme/unborn/commits?per_page=2",
    );
    // The probe rides the ONE installation token minted for the listing — it must
    // never re-mint (the "mint ONCE per listing" invariant + task-62 D9's budget).
    expect(probes[0].auth).toContain("ghs_minted");
  });

  it("reports a size:0 repo with exactly ONE commit as empty (the auto_init README case)", async () => {
    // THIS is the assertion that keeps every `auto_init` fixture repo listing as
    // empty, and therefore keeps the whole nextjs `test:e2e:real` lane alive.
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(JSON.stringify([commitEntry("readme")]), {
          status: 200,
        });
      }
      return listingResponse([rawRepo(101, "auto-init", 0)]);
    });

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    expect(repos[0].empty).toBe(true);
    expect(calls.filter((c) => isProbe(c.url))).toHaveLength(1);
  });

  it("short-circuits size > 0: exactly ONE probe is issued for a mixed page, targeting only the size:0 repo", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(JSON.stringify([commitEntry("readme")]), {
          status: 200,
        });
      }
      return listingResponse([
        rawRepo(101, "ambiguous", 0),
        rawRepo(103, "definitely-populated", 512),
      ]);
    });

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    expect(repos.map((r) => r.empty)).toEqual([true, false]);
    const probes = calls.filter((c) => isProbe(c.url));
    expect(probes).toHaveLength(1);
    expect(probes[0].url).toContain("/repos/acme/ambiguous/commits");
  });

  it("issues NO probe at all when there are zero size:0 candidates", async () => {
    // [GUARD, not RED] — trivially true before the probe existed, load-bearing
    // after it: task-62 D9's `expect(total()).toBe(4)` budget assertion (two
    // listings ⇒ exactly TWO mints and TWO listing GETs) survives ONLY on this
    // property. Making it an explicit, named test stops that from being luck.
    //
    // `PROBE_ALL` is passed DELIBERATELY (deferred review finding DR2 made the probe
    // opt-in). Without it this test would still pass — because no probe would be
    // requested at all — and would then be asserting the opt-in, not the `size > 0`
    // short-circuit it exists for. The caller here asks for a verdict on every row;
    // the point is that `size` already answered for all of them.
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) throw new Error("no probe should have been issued");
      return listingResponse([
        rawRepo(101, "a", 1),
        rawRepo(102, "b", 512),
        rawRepo(103, "c", 9000),
      ]);
    });

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    expect(repos.every((r) => r.empty === false)).toBe(true);
    expect(calls.filter((c) => isProbe(c.url))).toHaveLength(0);
    // The pre-probe request budget, unchanged: 1 mint + 1 listing GET.
    expect(calls).toHaveLength(2);
  });

  it("falls back to the size heuristic when a probe fails for an unexpected reason", async () => {
    // Probe-failure semantics (TDD plan §65.2a): a non-409 / non-200 answer means
    // UNKNOWN, so the repo keeps its `size`-derived verdict. That strictly
    // dominates the old behaviour — it can never be worse than the status quo —
    // whereas failing closed (`empty: false`) would hide a genuinely empty repo
    // from the picker on one transient 5xx and red-line the whole real lane.
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(JSON.stringify({ message: "Server Error" }), {
          status: 500,
        });
      }
      return listingResponse([
        rawRepo(101, "probe-fails", 0),
        rawRepo(103, "populated", 512),
      ]);
    });

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    // Nothing thrown, nothing dropped, and the `size === 0` fallback stands.
    expect(repos.map((r) => r.name)).toEqual(["probe-fails", "populated"]);
    expect(repos.map((r) => r.empty)).toEqual([true, false]);
    expect(calls.filter((c) => isProbe(c.url))).toHaveLength(1);
  });

  it("caps probe fan-out at EMPTINESS_PROBE_CONCURRENCY (8) in flight", async () => {
    // `listInstallationRepos` runs on EVERY repo-picker page load, against a live
    // installation that is `repository_selection: "all"` over a 563-repo account.
    // An unbounded per-candidate fan-out would be a 563-request burst straight into
    // GitHub's secondary rate limit. The pool is what makes the row's "at most one
    // request per candidate" budget survivable.
    const repos20 = Array.from({ length: 20 }, (_, i) =>
      rawRepo(200 + i, `empty-${i}`, 0),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    let probeCount = 0;
    const pending: (() => void)[] = [];

    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (!isProbe(url)) return listingResponse(repos20);
      probeCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Deferred: the probe only settles when this test releases it, so the
      // observed peak is the pool's real in-flight ceiling, not a scheduling
      // artifact.
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      return new Response(JSON.stringify([commitEntry("readme")]), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    let settled = false;
    const listing = build(fetchImpl)
      .listInstallationRepos({
        installationId: "42",
        deriveEmptinessFor: PROBE_ALL,
      })
      .then((r) => {
        settled = true;
        return r;
      });

    for (let tick = 0; tick < 200 && !settled; tick += 1) {
      await new Promise((r) => setTimeout(r, 0));
      while (pending.length) pending.shift()!();
    }
    const result = await listing;

    expect(result).toHaveLength(20);
    expect(result.every((r) => r.empty)).toBe(true);
    expect(probeCount).toBe(20);
    expect(EMPTINESS_PROBE_CONCURRENCY).toBe(8);
    // Genuinely parallel (not serial) AND genuinely bounded (not 20 at once).
    expect(maxInFlight).toBe(EMPTINESS_PROBE_CONCURRENCY);
  });

  it("a probe that REJECTS (network error) also falls back instead of failing the listing", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) throw new TypeError("fetch failed");
      return listingResponse([rawRepo(101, "probe-throws", 0)]);
    }) as unknown as typeof fetch;

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: PROBE_ALL,
    });

    expect(repos[0].empty).toBe(true);
    expect(calls.filter(isProbe)).toHaveLength(1);
  });
});

describe("makeGithubAppClient.getRepositoryFileContents", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("mints an installation token then reads the contents API with it, decoding base64→utf8", async () => {
    const raw = JSON.stringify({ manifestVersion: 1, hello: "world" });
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_minted_1",
            expires_at: "2026-07-19T13:00:00.000Z",
          }),
          { status: 201 },
        );
      }
      return new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          // GitHub wraps base64 content with newlines — the client must tolerate it.
          content: b64(raw).replace(/(.{4})/g, "$1\n"),
          sha: "abc123",
          path: "supagloo.project.json",
          name: "supagloo.project.json",
          size: raw.length,
        }),
        { status: 200 },
      );
    });
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    const file = await client.getRepositoryFileContents({
      installationId: "42",
      owner: "acme",
      repo: "psalms-video",
      path: "supagloo.project.json",
      ref: "v0.0.1",
    });

    // First mint (App JWT), then read (minted installation token).
    expect(calls[0].url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(calls[0].auth?.startsWith("Bearer ")).toBe(true);
    expect(isJwt(calls[0].auth!.slice("Bearer ".length))).toBe(true);

    expect(calls[1].url).toBe(
      "https://api.github.com/repos/acme/psalms-video/contents/supagloo.project.json?ref=v0.0.1",
    );
    expect(calls[1].auth).toContain("ghs_minted_1");
    expect(calls).toHaveLength(2);

    // Content is decoded to the exact UTF-8 bytes (whitespace in the base64 ignored).
    expect(file).toEqual({
      content: raw,
      sha: "abc123",
      path: "supagloo.project.json",
    });
  });

  it("returns null when the contents API 404s (missing file/branch/repo)", async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_x", expires_at: "2026-07-19T13:00:00.000Z" }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      });
    });
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    expect(
      await client.getRepositoryFileContents({
        installationId: "42",
        owner: "acme",
        repo: "psalms-video",
        path: "supagloo.project.json",
        ref: "v0.0.9",
      }),
    ).toBeNull();
  });

  it("throws on an unexpected upstream error (5xx), carrying the upstream status", async () => {
    // plan row 64: the contents read is retried on a 5xx with the INJECTED sleep (the
    // unit lane must never actually wait), then surfaces a typed error carrying the
    // upstream status.
    const sleeps: number[] = [];
    let reads = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_x", expires_at: "2026-07-19T13:00:00.000Z" }),
          { status: 201 },
        );
      }
      reads += 1;
      return new Response("boom", { status: 500 });
    });
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    const err = await client
      .getRepositoryFileContents({
        installationId: "42",
        owner: "acme",
        repo: "psalms-video",
        path: "supagloo.project.json",
        ref: "v0.0.1",
      })
      .then(
        () => null,
        (e: unknown) => e as GithubAppRequestError,
      );
    expect(err).toBeInstanceOf(GithubAppRequestError);
    expect(err?.upstreamStatus).toBe(500);
    expect(reads).toBe(DEFAULT_GITHUB_MAX_ATTEMPTS);
    expect(sleeps).toEqual([500, 1_000, 2_000]);
  });
});

// ===========================================================================
// task-62 D9 — the RECLASSIFIED "fresh token per call" counters.
//
// These assertions used to live in `tests/e2e/github-connection.e2e.ts` (:170-173)
// and `tests/e2e/manifest.e2e.ts` (:194-198) as reads of the github-stub's
// `/__stub/calls` counter after a `/__stub/reset`. Real GitHub exposes no
// per-caller call counter, so there is NO real-host analogue: the assertion is
// about OUR client's internal call pattern, which is exactly a unit-level
// property. Reclassified here with an injected COUNTING fetchImpl at the client
// boundary — strictly more precise than the stub ever was, because it attributes
// each HTTP call to the method that made it instead of to a shared container.
//
// What the e2e keeps instead: a REAL pagination proof (the live account has 100+
// repos, so `parseNextLink` genuinely walks `Link: rel="next"`).
// ===========================================================================

function countingFetch(handler: (url: string) => Response) {
  const byRoute = new Map<string, number>();
  const bump = (key: string) => byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    bump(`${init?.method ?? "GET"} ${path}`);
    return handler(url);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    count: (key: string) => byRoute.get(key) ?? 0,
    total: () => [...byRoute.values()].reduce((a, b) => a + b, 0),
  };
}

const mintResponse = (token = "ghs_minted") =>
  new Response(
    JSON.stringify({
      token,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }),
    { status: 201 },
  );

describe("task-62 D9: fresh-installation-token-per-call (was a github-stub counter)", () => {
  it("two listInstallationRepos calls ⇒ exactly TWO mints and TWO listing GETs", async () => {
    const { fetchImpl, count, total } = countingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(JSON.stringify({ total_count: 0, repositories: [] }), {
            status: 200,
          }),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    await client.listInstallationRepos({
      installationId: "77",
      deriveEmptinessFor: PROBE_ALL,
    });
    await client.listInstallationRepos({
      installationId: "77",
      deriveEmptinessFor: PROBE_ALL,
    });

    // No caching across calls: one exchange per listing, never reused.
    expect(count("POST /app/installations/77/access_tokens")).toBe(2);
    expect(count("GET /installation/repositories")).toBe(2);
    // And nothing else was called.
    //
    // plan row 65 / D65.6: this `4` SURVIVES the emptiness probe only because the
    // fixture lists ZERO repositories, so there are zero `size === 0` candidates and
    // the probe is skipped entirely. That is a deliberate property of the client, not
    // luck — it is pinned by its own named test, "issues NO probe at all when there
    // are zero size:0 candidates". If this ever goes to 5 or 6, do NOT raise the
    // number: the probe has started firing where it should not, and D9's whole
    // request-budget assertion would be silently retired by the edit.
    //
    // Both calls pass `PROBE_ALL` on purpose (DR2 made the probe opt-in): the budget
    // must hold for the MOST expensive caller, not merely for one that opted out.
    expect(total()).toBe(4);
  });

  it("one getRepositoryFileContents ⇒ exactly ONE mint and ONE contents GET", async () => {
    const { fetchImpl, count, total } = countingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(
            JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from("{}", "utf8").toString("base64"),
              sha: "deadbeef",
              path: "supagloo.project.json",
            }),
            { status: 200 },
          ),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

    await client.getRepositoryFileContents({
      installationId: "77",
      owner: "octo",
      repo: "widget",
      path: "supagloo.project.json",
      ref: "v0.0.1",
    });

    expect(count("POST /app/installations/77/access_tokens")).toBe(1);
    expect(count("GET /repos/octo/widget/contents/supagloo.project.json")).toBe(1);
    expect(total()).toBe(2);
  });

  it("a multi-segment contents path is not collapsed (real Contents API accepts it)", async () => {
    // The retired github-stub only ever routed a SINGLE path segment, so nested
    // manifest paths were untested. Real GitHub accepts arbitrary depth.
    const { fetchImpl, count } = countingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(
            JSON.stringify({
              type: "file",
              encoding: "base64",
              content: Buffer.from("{}", "utf8").toString("base64"),
              sha: "s",
              path: "cfg/nested/supagloo.project.json",
            }),
            { status: 200 },
          ),
    );
    const client = makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });
    const file = await client.getRepositoryFileContents({
      installationId: "77",
      owner: "octo",
      repo: "widget",
      path: "cfg/nested/supagloo.project.json",
      ref: "main",
    });
    expect(file?.path).toBe("cfg/nested/supagloo.project.json");
    expect(
      count("GET /repos/octo/widget/contents/cfg/nested/supagloo.project.json"),
    ).toBe(1);
  });
});

// ===========================================================================
// task-62 §11.6 — failure injection that the github-stub used to FAKE, now at
// unit level with an injected fetch (design-delta §10.6: never real e2e egress).
// Each case is a shape real api.github.com actually returns.
// ===========================================================================

describe("task-62 §11.6: real-GitHub failure shapes (injected fetch, zero egress)", () => {
  const client = (fetchImpl: typeof fetch, privateKey = PRIVATE_KEY) =>
    makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey,
      fetchImpl,
    });

  it("401 'A JWT could not be decoded' surfaces the status (bad appId/PEM pairing)", async () => {
    // Row 62 item (c)'s bug class: a PEM whose newlines were mangled, or an
    // appId that does not belong to the key, yields a signed-but-rejected JWT.
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ message: "A JWT could not be decoded" }),
          { status: 401 },
        ),
    );
    await expect(client(fetchImpl).verifyInstallation("77")).rejects.toThrow(
      /401/,
    );
  });

  it("a PEM that is not a usable private key throws at SIGN time, before any network call", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response("{}", { status: 200 }),
    );
    await expect(
      client(fetchImpl, "-----BEGIN RSA PRIVATE KEY-----\nnot-base64\n-----END RSA PRIVATE KEY-----")
        .verifyInstallation("77"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("404 on the token exchange (unknown/removed installation) fails the listing", async () => {
    // Row 62 item (d)'s bug class exactly: the fabricated installation `42` 404s
    // against real GitHub. The failure must be attributable to the exchange.
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    await expect(
      client(fetchImpl).listInstallationRepos({ installationId: "999999" }),
    ).rejects.toThrow(/installation token exchange failed for installation 999999/);
    // It never proceeded to the listing call.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/app/installations/999999/access_tokens");
  });

  it("403 + Retry-After IS retried by the client, honouring the delay (plan row 64)", async () => {
    // TOMBSTONE REPLACED (plan row 64 / D64.8). This test used to pin the OPPOSITE
    // contract — *"403 + Retry-After is NOT retried by the client today (deferred:
    // task-62 D19-N2)"*, `expect(calls).toHaveLength(1)` — and its own body said "if a
    // future task adds retry, this test is the one that must be updated deliberately".
    // This is that update, written deliberately rather than extended or deleted.
    //
    // What changed: every request this client makes now runs through db-lib's
    // `withGithubRetry` (§11.7 "one implementation, four consumers"), which honours
    // GitHub's own `Retry-After` with a bounded, capped budget. The sleep is INJECTED,
    // so the unit lane never actually waits (§10.6 / the egress rule) — and that
    // injection is exactly what this test asserts, not an incidental convenience.
    const sleeps: number[] = [];
    let mintAttempts = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        mintAttempts += 1;
        if (mintAttempts === 1) {
          return new Response(
            JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
            { status: 403, headers: { "retry-after": "17" } },
          );
        }
        return mintResponse();
      }
      return listingResponse([]);
    });

    const repos = await makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    }).listInstallationRepos({ installationId: "77" });

    // The delay GitHub asked for was honoured, once, and then the call was RETRIED
    // rather than surfaced as a failure.
    expect(sleeps).toEqual([17_000]);
    expect(mintAttempts).toBe(2);
    expect(repos).toEqual([]);
  });

  it("a 403 + Retry-After that never clears gives up after the bounded budget, surfacing the header verbatim", async () => {
    const sleeps: number[] = [];
    let mintAttempts = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) mintAttempts += 1;
      return new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
        { status: 403, headers: { "retry-after": "60" } },
      );
    });

    const err = await makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    })
      .listInstallationRepos({ installationId: "77" })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(mintAttempts).toBe(DEFAULT_GITHUB_MAX_ATTEMPTS);
    expect(sleeps).toEqual([60_000, 60_000, 60_000]);
    expect(err?.message).toMatch(/403/);
    // The header value is surfaced VERBATIM so an operator sees what GitHub asked
    // for. It is deliberately never ASSERTED ON in an e2e — only here, against an
    // injected response (§11.9).
    expect(err?.message).toContain("Retry-After: 60");
    // ...and never the signed App JWT (db-lib `github.test.ts` "JWT not leaked").
    expect(err?.message).not.toContain("Bearer");
  });

  it("does NOT retry a bare permission-denial 403 (no throttle headers)", async () => {
    // [GUARD, not RED] — §11.3:1832-1834 makes this load-bearing: the installation
    // deliberately holds no `administration` scope, so a genuine permission-denial 403
    // is EXPECTED behaviour of the credential split, not a rate limit. Retrying it
    // would turn a crisp, instant failure into four attempts and three sleeps.
    const sleeps: number[] = [];
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ message: "Resource not accessible by integration" }),
          { status: 403 },
        ),
    );
    await expect(
      makeGithubAppClient({
        apiBaseUrl: "https://api.github.com",
        appId: APP_ID,
        privateKey: PRIVATE_KEY,
        fetchImpl,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      }).listInstallationRepos({ installationId: "77" }),
    ).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("429 on a mid-pagination page that CLEARS is retried, and the listing completes whole", async () => {
    // The complement of the invariant below: backing off must actually RECOVER the
    // page, not merely delay the same failure. Page 2 answers 429 once, then 200 —
    // and the union of both pages is returned.
    const sleeps: number[] = [];
    let page2Attempts = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(JSON.stringify([commitEntry("readme")]), { status: 200 });
      }
      const page = new URL(url).searchParams.get("page") ?? "1";
      if (page === "1") {
        return new Response(
          JSON.stringify({ total_count: 2, repositories: [rawRepo(1, "a", 0)] }),
          {
            status: 200,
            headers: {
              link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
            },
          },
        );
      }
      page2Attempts += 1;
      if (page2Attempts === 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "3", "x-ratelimit-remaining": "0" },
        });
      }
      return listingResponse([rawRepo(2, "b", 512)]);
    });

    const repos = await makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    }).listInstallationRepos({
      installationId: "77",
      deriveEmptinessFor: PROBE_ALL,
    });

    expect(repos.map((r) => r.name)).toEqual(["a", "b"]);
    expect(page2Attempts).toBe(2);
    expect(sleeps).toEqual([3_000]);
  });

  it("429 on a mid-pagination page fails the whole listing rather than truncating it", async () => {
    // The dangerous failure mode is a SILENT partial listing: the user's repo
    // simply missing from the picker. A rate-limited page must throw.
    //
    // plan row 65: this test's counts are UNMOVED by the emptiness probe, and that is
    // structural rather than incidental — the page walk throws before the probe stage
    // is ever reached, so the `size: 0` repo already collected from page 1 is never
    // probed. The invariant under test ("fail the listing, never truncate it") is
    // therefore untouched. If a future change makes probes fire from inside the page
    // loop, this count moves and that is the signal, not a nuisance.
    //
    // plan row 64 / D64.8: the COUNT moved (2 → 1 + DEFAULT_GITHUB_MAX_ATTEMPTS) because
    // the client now backs off before giving up. THE INVARIANT DID NOT: a 429 that never
    // clears still fails the whole listing. Never weaken the `rejects` half of this test
    // to accommodate a count — a partial listing is the bug it exists to catch.
    const sleeps: number[] = [];
    let listingCalls = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      listingCalls += 1;
      if (listingCalls === 1) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            repositories: [
              {
                id: 1,
                name: "a",
                full_name: "octo/a",
                owner: { login: "octo" },
                private: true,
                default_branch: "main",
                size: 0,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
            },
          },
        );
      }
      return new Response(JSON.stringify({ message: "rate limited" }), {
        status: 429,
        headers: { "x-ratelimit-remaining": "0" },
      });
    });
    await expect(
      makeGithubAppClient({
        apiBaseUrl: "https://api.github.com",
        appId: APP_ID,
        privateKey: PRIVATE_KEY,
        fetchImpl,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      }).listInstallationRepos({ installationId: "77" }),
    ).rejects.toThrow(/429/);
    expect(listingCalls).toBe(1 + DEFAULT_GITHUB_MAX_ATTEMPTS);
    // No `Retry-After` and no `x-ratelimit-reset` ⇒ the blind exponential fallback.
    expect(sleeps).toEqual([500, 1_000, 2_000]);
  });

  it("422 from the contents read is a throw, distinct from the 404 → null outcome", async () => {
    const { fetchImpl } = recordingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(
            JSON.stringify({ message: "Unprocessable Entity" }),
            { status: 422 },
          ),
    );
    await expect(
      client(fetchImpl).getRepositoryFileContents({
        installationId: "77",
        owner: "octo",
        repo: "widget",
        path: "supagloo.project.json",
        ref: "main",
      }),
    ).rejects.toThrow(/422/);
  });

  it("a DIRECTORY response (path points at a dir) fails the parse rather than decoding garbage", async () => {
    // Real GitHub returns a JSON ARRAY for a directory. `fileContentsSchema`
    // requires `type:"file"`, so this must not silently produce empty content.
    const { fetchImpl } = recordingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(JSON.stringify([{ type: "file", name: "a.json" }]), {
            status: 200,
          }),
    );
    await expect(
      client(fetchImpl).getRepositoryFileContents({
        installationId: "77",
        owner: "octo",
        repo: "widget",
        path: "cfg",
        ref: "main",
      }),
    ).rejects.toThrow();
  });

  it("encoding:'none' (>1MB file, Contents API representation switch) fails loudly", async () => {
    // Real GitHub switches to `encoding:"none"` + empty content above 1MB and
    // requires the blob API. Every Supagloo manifest is far under the cap, so the
    // right behaviour is a loud parse failure, never a silently-empty manifest.
    const { fetchImpl } = recordingFetch((url) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(
            JSON.stringify({
              type: "file",
              encoding: "none",
              content: "",
              sha: "big",
              path: "supagloo.project.json",
            }),
            { status: 200 },
          ),
    );
    await expect(
      client(fetchImpl).getRepositoryFileContents({
        installationId: "77",
        owner: "octo",
        repo: "widget",
        path: "supagloo.project.json",
        ref: "main",
      }),
    ).rejects.toThrow();
  });

  it("verifyInstallation tolerates an Organization account payload (login is what we store)", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 77,
            account: { login: "some-org", type: "Organization" },
            repository_selection: "all",
          }),
          { status: 200 },
        ),
    );
    expect(await client(fetchImpl).verifyInstallation("77")).toEqual({
      githubLogin: "some-org",
      repositorySelection: "all",
    });
  });
});

// ===========================================================================
// plan row 64 — the two-layer rate-limit rule, api half (D64.1 / D64.2).
//
// Every request this client issues that the caller CANNOT fall back from — the
// installation-token exchange, the `GET /app/installations/:id` verify, the paginated
// listing walk, the Contents read — runs through db-lib's `withGithubRetry`, honouring
// `Retry-After` / `x-ratelimit-reset` with a bounded, capped, INJECTED-sleep backoff.
//
// The ONE deliberate exception is the row-65 emptiness probe, which is best-effort
// enrichment with a documented fallback (`size === 0`), so a throttled probe degrades
// instantly instead of stalling an interactive route. That asymmetry is a decision, so
// it gets its own named test rather than being left to a reader's inference.
// ===========================================================================

describe("plan row 64: bounded rate-limit backoff (injected sleep, zero egress)", () => {
  const buildWithSleep = (fetchImpl: typeof fetch, sleeps: number[]) =>
    makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

  it("retries a 403 + Retry-After on the LISTING GET (not just the token exchange)", async () => {
    const sleeps: number[] = [];
    let listingAttempts = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      listingAttempts += 1;
      if (listingAttempts === 1) {
        return new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
          { status: 403, headers: { "retry-after": "5" } },
        );
      }
      return listingResponse([rawRepo(101, "populated", 512)]);
    });

    const repos = await buildWithSleep(fetchImpl, sleeps).listInstallationRepos({
      installationId: "77",
    });

    expect(repos.map((r) => r.name)).toEqual(["populated"]);
    expect(listingAttempts).toBe(2);
    expect(sleeps).toEqual([5_000]);
  });

  it("retries a 403 + x-ratelimit-remaining:0 on the CONTENTS read, then returns the file", async () => {
    const sleeps: number[] = [];
    let reads = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      reads += 1;
      if (reads === 1) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          // No `Retry-After`: the exhausted-quota signal is `x-ratelimit-remaining: 0`,
          // and the delay then comes from `x-ratelimit-reset`.
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 4),
          },
        });
      }
      return new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: Buffer.from('{"manifestVersion":1}', "utf8").toString("base64"),
          sha: "abc",
          path: "supagloo.project.json",
        }),
        { status: 200 },
      );
    });

    const file = await buildWithSleep(fetchImpl, sleeps).getRepositoryFileContents({
      installationId: "77",
      owner: "octo",
      repo: "widget",
      path: "supagloo.project.json",
      ref: "main",
    });

    expect(file?.content).toBe('{"manifestVersion":1}');
    expect(reads).toBe(2);
    // Derived from `x-ratelimit-reset`, so it is a wall-clock delta rather than a fixed
    // number — assert the BAND, never the exact value (a clock-exact assertion here is a
    // flake factory).
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(4_000);
  });

  it("caps a preposterous Retry-After at 60s (D64.6) rather than stalling the request", async () => {
    // A ProjectJob that sits in `running` for an hour widens the §2.9 409 git-ops
    // window; the cap is what bounds that.
    const sleeps: number[] = [];
    let mintAttempts = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        mintAttempts += 1;
        if (mintAttempts === 1) {
          return new Response(JSON.stringify({ message: "secondary rate limit" }), {
            status: 403,
            headers: { "retry-after": "3600" },
          });
        }
        return mintResponse();
      }
      return listingResponse([]);
    });

    await buildWithSleep(fetchImpl, sleeps).listInstallationRepos({
      installationId: "77",
    });
    expect(sleeps).toEqual([60_000]);
  });

  it("does NOT retry the emptiness probe — a throttled probe falls back to `size` instantly", async () => {
    // DELIBERATE ASYMMETRY, not an oversight. The probe is the ONLY request here whose
    // failure has a defined fallback (`size === 0`, row 65's documented UNKNOWN path), and
    // it is the request most likely to trip a secondary limit: it fans out over every
    // `size: 0` candidate on an INTERACTIVE per-page-load route (measured: 55 candidates
    // on the live installation). Retrying it would turn one throttled page load into
    // ceil(55/8) x 3 x 60s of in-request sleeping for an answer we already have a safe
    // default for. Retry what you cannot fall back from; degrade what you can.
    const sleeps: number[] = [];
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(JSON.stringify({ message: "secondary rate limit" }), {
          status: 403,
          headers: { "retry-after": "60" },
        });
      }
      return listingResponse([rawRepo(101, "candidate", 0)]);
    });

    const repos = await buildWithSleep(fetchImpl, sleeps).listInstallationRepos({
      installationId: "77",
      deriveEmptinessFor: PROBE_ALL,
    });

    expect(calls.filter((c) => isProbe(c.url))).toHaveLength(1);
    expect(sleeps).toEqual([]);
    // The `size`-derived verdict stands, and nothing was thrown.
    expect(repos.map((r) => r.empty)).toEqual([true]);
  });

  it("attaches the upstream status to all three of the client's own non-2xx throws", async () => {
    // The three bare `new Error(...)` sites this row replaced: the installation verify,
    // the listing walk, and the Contents read. `upstreamStatus` is GitHub's status;
    // `statusCode` is OUR reply status — see the class doc-comment for why they are
    // separate names.
    const deny = (url: string) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(JSON.stringify({ message: "Resource not accessible" }), {
            status: 403,
          });

    const sleeps: number[] = [];
    const verifyErr = await buildWithSleep(recordingFetch(deny).fetchImpl, sleeps)
      .verifyInstallation("77")
      .then(
        () => null,
        (e: unknown) => e as GithubAppRequestError,
      );
    expect(verifyErr).toBeInstanceOf(GithubAppRequestError);
    expect(verifyErr?.upstreamStatus).toBe(403);

    const listErr = await buildWithSleep(recordingFetch(deny).fetchImpl, sleeps)
      .listInstallationRepos({ installationId: "77" })
      .then(
        () => null,
        (e: unknown) => e as GithubAppRequestError,
      );
    expect(listErr).toBeInstanceOf(GithubAppRequestError);
    expect(listErr?.upstreamStatus).toBe(403);

    const readErr = await buildWithSleep(recordingFetch(deny).fetchImpl, sleeps)
      .getRepositoryFileContents({
        installationId: "77",
        owner: "octo",
        repo: "widget",
        path: "supagloo.project.json",
        ref: "main",
      })
      .then(
        () => null,
        (e: unknown) => e as GithubAppRequestError,
      );
    expect(readErr).toBeInstanceOf(GithubAppRequestError);
    expect(readErr?.upstreamStatus).toBe(403);

    // A bare permission-denial 403 never sleeps, on ANY of the three paths.
    expect(sleeps).toEqual([]);
  });

  it("none of the three throws carries a Fastify-consumable `status` field", async () => {
    // The OBJECT-level half of the guard; the WIRE-level half is the describe block
    // below, and it is the one that actually proves "replies 502".
    //
    // Fastify's default error handler prefers `error.status` over `error.statusCode`
    // (`fastify/lib/error-handler.js` `setErrorHeaders`), so an error field literally
    // named `status` silently becomes the HTTP reply code — turning a GitHub 401 into
    // OUR 401 and logging the user out on an upstream credential fault. That is why the
    // upstream value is `upstreamStatus` and the reply value is `statusCode = 502`.
    const deny = (url: string) =>
      url.endsWith("/access_tokens")
        ? mintResponse()
        : new Response(JSON.stringify({ message: "Bad credentials" }), {
            status: 401,
          });
    const sleeps: number[] = [];
    const build = () => buildWithSleep(recordingFetch(deny).fetchImpl, sleeps);
    const catchIt = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e as GithubAppRequestError & { status?: number },
      );

    // All THREE call paths, not just the verify — the sibling test above already
    // loops over all three, and this one used to check only one of them.
    for (const err of [
      await catchIt(build().verifyInstallation("77")),
      await catchIt(build().listInstallationRepos({ installationId: "77" })),
      await catchIt(
        build().getRepositoryFileContents({
          installationId: "77",
          owner: "octo",
          repo: "widget",
          path: "supagloo.project.json",
          ref: "main",
        }),
      ),
    ]) {
      expect(err).toBeInstanceOf(GithubAppRequestError);
      expect(err?.statusCode).toBe(502);
      expect(err?.upstreamStatus).toBe(401);
      expect(err?.status).toBeUndefined();
    }
  });
});

// ===========================================================================
// plan row 65 FOLLOW-UP (deferred review finding DR2) — the probe is OPT-IN.
//
// Row 65 shipped the probe inside `listInstallationRepos`, i.e. over the FULL
// installation listing, BEFORE `GithubConnectionService.listRepos` applies
// `filterRepos(repos, {filter, q})`. Two costs nobody booked:
//
//   1. `GET /v1/github/repos` is NOT only the repo picker. nextjs
//      `app/_components/session-provider.tsx` calls `fetchGithubRepoCount()` from an
//      effect that runs on EVERY hard page load of every page, purely to render an
//      "N repos accessible" count — a caller that never reads `empty` at all. On the
//      live installation (582 repos, 6 pages, 55 of them `size: 0`) that made one
//      page load ~62 GitHub requests against a ~5,000/hour installation budget:
//      ~80 page loads to exhaustion, down from ~700. And the listing GETs (unlike the
//      probes) THROW on exhaustion, so the picker fails outright rather than degrading.
//   2. `?filter=empty&q=<name>` narrows to a single repo and still paid the whole
//      55-candidate fan-out.
//
// The fix is intent, threaded down: `deriveEmptinessFor` names the repos the caller
// will actually read `empty` on. Omitted ⇒ ZERO probes. The row-65 properties are
// untouched and still pinned by their own tests above — the `size > 0` short-circuit,
// the concurrency cap, null-is-UNKNOWN, and the deliberate non-retry.
// ===========================================================================

describe("plan row 65 follow-up (DR2): the emptiness probe is opt-in per caller", () => {
  const build = (fetchImpl: typeof fetch) =>
    makeGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
    });

  it("issues NO probe when the caller does not ask for an emptiness verdict", async () => {
    // THE page-load path: `GET /v1/github/repos` with no `filter=empty` and no `q`.
    // Every repo here is a `size: 0` candidate, so the pre-fix client would have
    // probed all four. The caller never reads `empty`, so the correct cost is zero.
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) throw new Error("no probe should have been issued");
      return listingResponse([
        rawRepo(101, "a", 0),
        rawRepo(102, "b", 0),
        rawRepo(103, "c", 0),
        rawRepo(104, "d", 0),
      ]);
    });

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
    });

    expect(calls.filter((c) => isProbe(c.url))).toHaveLength(0);
    // 1 mint + 1 listing GET, and NOTHING else.
    expect(calls).toHaveLength(2);
    // The provisional `size`-derived verdict is what is returned — exactly the
    // pre-row-65 answer, which is all a caller that does not read `empty` needs.
    expect(repos.map((r) => r.empty)).toEqual([true, true, true, true]);
  });

  it("probes ONLY the repos that survive the caller's narrowing", async () => {
    // `?filter=empty&q=target` must cost ONE probe, not one per `size: 0` repo in
    // the whole installation.
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(JSON.stringify([commitEntry("readme")]), { status: 200 });
      }
      return listingResponse([
        rawRepo(101, "noise-one", 0),
        rawRepo(102, "target", 0),
        rawRepo(103, "noise-two", 0),
      ]);
    });

    const repos = await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: (repo) => repo.name === "target",
    });

    const probes = calls.filter((c) => isProbe(c.url));
    expect(probes).toHaveLength(1);
    expect(probes[0].url).toBe(
      "https://api.github.com/repos/acme/target/commits?per_page=2",
    );
    // Un-probed rows keep the provisional verdict; nothing is dropped.
    expect(repos.map((r) => r.name)).toEqual(["noise-one", "target", "noise-two"]);
  });

  it("still short-circuits size > 0 even when the caller admits every repo", async () => {
    // The predicate NARROWS; it never widens. `deriveEmptinessFor: () => true` must
    // not resurrect a probe for a repo whose `size` already answered definitively.
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      if (isProbe(url)) {
        return new Response(JSON.stringify([commitEntry("readme")]), { status: 200 });
      }
      return listingResponse([
        rawRepo(101, "candidate", 0),
        rawRepo(102, "populated", 512),
      ]);
    });

    await build(fetchImpl).listInstallationRepos({
      installationId: "42",
      deriveEmptinessFor: () => true,
    });

    const probes = calls.filter((c) => isProbe(c.url));
    expect(probes).toHaveLength(1);
    expect(probes[0].url).toContain("/repos/acme/candidate/commits");
  });
});

// ===========================================================================
// plan row 64 FOLLOW-UP (deferred review finding DR3) — the INTERACTIVE budget.
//
// Row 64 wrapped every non-fallback request in `withGithubRetry` with NO
// `maxAttempts` and no deadline, so each wrapped call could sleep up to 3 x 60 s.
// `listInstallationRepos` makes 1 wrapped mint + N wrapped page GETs (6 measured)
// and `getRepositoryFileContents` makes 2 — each retried INDEPENDENTLY, so a
// throttled installation could hold `GET /v1/github/repos` (and the browser
// connection behind it) open for ~24 minutes. Before row 64 these routes failed fast.
//
// D64.1 reasoned only about the DBOS step budget. The same primitive now sits on a
// page-load path, and a page load must fail fast: there is a human waiting, and the
// repo picker degrades to "try again" far better than to a hung tab.
//
// So the API constructs an INTERACTIVE client (`makeInteractiveGithubAppClient`,
// wired in `src/server.ts`) with a much tighter budget, while db-lib's defaults —
// and therefore every DBOS workflow, where a slow success genuinely beats a fast
// failure — are left exactly as they are.
// ===========================================================================

describe("plan row 64 follow-up (DR3): the interactive client's tighter budget", () => {
  it("keeps the interactive budget strictly under db-lib's workflow default", () => {
    expect(INTERACTIVE_GITHUB_MAX_ATTEMPTS).toBeLessThan(
      DEFAULT_GITHUB_MAX_ATTEMPTS,
    );
    // A whole listing's in-request sleeping, bounded. db-lib's per-request worst case
    // is 3 x 60s = 180s, and a 7-request listing multiplied that by seven.
    expect(INTERACTIVE_GITHUB_RETRY_BUDGET_MS).toBeLessThan(180_000);
  });

  it("retries a throttled request FEWER times than the db-lib default", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = recordingFetch(
      () => new Response("boom", { status: 500 }),
    );
    const err = await makeInteractiveGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    })
      .verifyInstallation("42")
      .then(
        () => null,
        (e: unknown) => e as GithubAppRequestError,
      );

    expect(err).toBeInstanceOf(GithubAppRequestError);
    expect(calls).toHaveLength(INTERACTIVE_GITHUB_MAX_ATTEMPTS);
    expect(sleeps).toHaveLength(INTERACTIVE_GITHUB_MAX_ATTEMPTS - 1);
    // Strictly fewer than the workflow client would have made.
    expect(calls.length).toBeLessThan(DEFAULT_GITHUB_MAX_ATTEMPTS);
  });

  it("caps TOTAL in-request sleeping across a WHOLE listing, not per request", async () => {
    // The defect DR3 names: the mint and each of N pages had INDEPENDENT budgets, so
    // the wall clock multiplied by the page count. One deadline, shared, is what makes
    // the route's worst case a property of the route rather than of the account size.
    const sleeps: number[] = [];
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) return mintResponse();
      // EVERY page answers a 60s secondary-limit throttle, forever, across a
      // multi-page walk. Unbounded, this is (1 + pages) x 3 x 60s of sleeping.
      return new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
        { status: 403, headers: { "retry-after": "60" } },
      );
    });

    await makeInteractiveGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    })
      .listInstallationRepos({ installationId: "77" })
      .catch(() => null);

    const total = sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(INTERACTIVE_GITHUB_RETRY_BUDGET_MS);
    // ...and the budget is actually SPENT (this is a real throttle, not a no-op path).
    expect(total).toBeGreaterThan(0);
  });

  it("shares ONE budget across the mint AND every page of a listing", async () => {
    // Proof the deadline spans the whole call: the mint burns the budget first, so the
    // page GET that follows it has nothing left to sleep with.
    const sleeps: number[] = [];
    let mintAttempts = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.endsWith("/access_tokens")) {
        mintAttempts += 1;
        if (mintAttempts === 1) {
          return new Response(JSON.stringify({ message: "secondary rate limit" }), {
            status: 403,
            headers: { "retry-after": "3600" },
          });
        }
        return mintResponse();
      }
      return new Response(JSON.stringify({ message: "rate limited" }), {
        status: 429,
        headers: { "retry-after": "60" },
      });
    });

    await makeInteractiveGithubAppClient({
      apiBaseUrl: "https://api.github.com",
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    })
      .listInstallationRepos({ installationId: "77" })
      .catch(() => null);

    // The mint's own throttle consumed the entire shared budget (clamped from the
    // 3600s GitHub asked for), so the listing walk that followed slept 0.
    expect(sleeps[0]).toBe(INTERACTIVE_GITHUB_RETRY_BUDGET_MS);
    expect(sleeps.slice(1).every((ms) => ms === 0)).toBe(true);
  });

  it("[GUARD] leaves db-lib's full budget intact when no interactive budget is set", () => {
    // The DBOS workflows must keep the 4-attempt / 60s-per-sleep behaviour: there is
    // no human waiting on a durable step, and a slow success beats a fast failure.
    // The row-64 tests above assert that verbatim (4 attempts, [500, 1000, 2000]) on a
    // client built WITHOUT the interactive options, so this is a signpost to them.
    expect(DEFAULT_GITHUB_MAX_ATTEMPTS).toBe(4);
  });
});

// ════════════════════════ THE FASTIFY TRAP, AT THE WIRE ══════════════════════
//
// Asserting fields on an error object does not prove what a browser receives. This
// block drives each of the client's three call paths through the REAL route that
// reaches it, with a hostile fake fetch, and asserts the status `app.inject` sees:
//
//   verifyInstallation        → POST /connections/github/callback
//   listInstallationRepos     → GET  /github/repos
//   getRepositoryFileContents → GET  /projects/:id/manifest
//
// Two DIFFERENT error classes escape those paths and both must be caught:
//   • `GithubAppRequestError` — this client's own non-2xx throw. Names the upstream
//     status `upstreamStatus` precisely so Fastify cannot consume it.
//   • db-lib's `GithubAppError` — thrown by `mintInstallationToken`, which runs FIRST
//     inside both `listInstallationRepos` and `getRepositoryFileContents`. This is the
//     class where the trap was actually LIVE: it carried the upstream status in a field
//     named `status` until plan row 63-68's follow-up renamed it, so a GitHub 401 on the
//     token exchange was replied to the browser as a 401 (telling the caller to
//     re-authenticate, indistinguishable from a real session expiry, when OUR credential
//     was the broken one) and a 404 as a spurious not-found.
//
// The route-level catch is what makes this hold regardless of the field names any
// present or future provider error class happens to use.

/** Auth that admits exactly one bearer token, so these cases isolate the error path. */
const wireAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

/**
 * Mount the three real routes over the real client, wired through fake services that do
 * nothing but delegate — the same single call each real service makes — so the client's
 * raw throw reaches the route exactly as it does in production.
 */
async function buildWireApp(fetchImpl: typeof fetch): Promise<FastifyInstance> {
  const client = makeGithubAppClient({
    apiBaseUrl: "https://api.github.com",
    appId: APP_ID,
    privateKey: PRIVATE_KEY,
    fetchImpl,
    sleepImpl: async () => {},
  });
  const unreachable = () => {
    throw new Error("the hostile fetch was expected to fail this call");
  };
  const githubService = {
    installUrl: () => "https://github.com/apps/supagloo-app/installations/new",
    connectFromCallback: async (_userId: string, installationId: string) => {
      await client.verifyInstallation(installationId);
      return unreachable();
    },
    disconnect: async () => {},
    listRepos: async () => {
      await client.listInstallationRepos({ installationId: "77" });
      return unreachable();
    },
  } as never;
  const manifestService = {
    readManifest: async () => {
      await client.getRepositoryFileContents({
        installationId: "77",
        owner: "acme",
        repo: "widget",
        path: "supagloo.project.json",
        ref: "main",
      });
      return unreachable();
    },
  } as never;

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(bearerAuthPlugin, { authService: wireAuthService as never });
  registerGithubConnectionRoutes(app, { service: githubService });
  registerGithubRepoRoutes(app, { service: githubService });
  registerManifestRoutes(app, { service: manifestService });
  await app.ready();
  return app;
}

const WIRE_BEARER = { authorization: "Bearer valid" };

/** The three (route, request) pairs, one per client call path. */
const WIRE_PATHS = [
  {
    what: "verifyInstallation via POST /connections/github/callback",
    inject: {
      method: "POST" as const,
      url: "/connections/github/callback",
      headers: WIRE_BEARER,
      payload: { installationId: "77" },
    },
  },
  {
    what: "listInstallationRepos via GET /github/repos",
    inject: {
      method: "GET" as const,
      url: "/github/repos",
      headers: WIRE_BEARER,
    },
  },
  {
    what: "getRepositoryFileContents via GET /projects/:id/manifest",
    inject: {
      method: "GET" as const,
      url: "/projects/p1/manifest",
      headers: WIRE_BEARER,
    },
  },
];

describe("the Fastify trap, at the wire: every GitHub failure replies 502", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  // ── The client's OWN throw (`GithubAppRequestError`). The mint succeeds so the
  //    failure lands on the request after it. 404 is excluded deliberately: it is a
  //    real product outcome on two of these paths (no such installation → 400; no such
  //    file/branch → the caller's 404), not an upstream fault.
  for (const upstream of [401, 403, 500]) {
    for (const path of WIRE_PATHS) {
      it(`${path.what} replies 502 on a GitHub ${upstream}`, async () => {
        const { fetchImpl } = recordingFetch((url) =>
          url.endsWith("/access_tokens")
            ? mintResponse()
            : new Response(JSON.stringify({ message: "denied" }), {
                status: upstream,
              }),
        );
        app = await buildWireApp(fetchImpl);
        const res = await app.inject(path.inject);
        expect(res.statusCode).toBe(502);
        expect(res.json().error).toBe("github_upstream_failed");
      });
    }
  }

  // ── db-lib's `GithubAppError`: the TOKEN EXCHANGE itself fails. Only the two minting
  //    paths can reach it (`verifyInstallation` signs an App JWT and never mints), and
  //    it is the class where the status hijack was live.
  for (const upstream of [401, 404, 500]) {
    for (const path of WIRE_PATHS.slice(1)) {
      it(`${path.what} replies 502 when the token exchange itself ${upstream}s`, async () => {
        const { fetchImpl } = recordingFetch(
          () =>
            new Response(JSON.stringify({ message: "Bad credentials" }), {
              status: upstream,
            }),
        );
        app = await buildWireApp(fetchImpl);
        const res = await app.inject(path.inject);
        // Not `upstream`. A GitHub 401 here is OUR credential being wrong, not the
        // caller's session expiring; a GitHub 404 here is not a missing manifest.
        expect(res.statusCode).toBe(502);
        expect(res.json().error).toBe("github_upstream_failed");
      });
    }
  }
});
