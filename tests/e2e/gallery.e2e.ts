import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  createPrismaClient,
  deriveScriptureBook,
  type PrismaClient,
} from "@supagloo/database-lib";
import { buildApp } from "../../src/app";
import { AuthService } from "../../src/auth/auth-service";
import { SESSION_TTL_MS } from "../../src/auth/tokens";
import { makeS3Client, type S3EnvConfig } from "../../src/files/s3-client";
import { FilesService } from "../../src/files/files-service";
import { GalleryService } from "../../src/gallery/gallery-service";
import { decodeCursor } from "../../src/gallery/gallery-query";
import { sortByTrendingDesc } from "../../src/gallery/trending";

// Non-UI e2e for the Task #39 gallery surface + the Task #40 upvotes. Boots the REAL
// Fastify app in-process (real listen + real fetch) against REAL Postgres (Compose
// `supagloo`) and the REAL Compose MinIO. Sessions come from the real
// `POST /v1/test/seed` seam; project / RenderJob fixtures are direct Prisma writes and
// real bytes PUT into MinIO; gallery items are created by calling the REAL
// `POST /v1/renders/:id/gallery`. No stub anywhere, and no extension of the seed route
// (§9-Q9 round 2 keeps it at users + sessions only).
//
// ZERO PROVIDER EGRESS, AND THEREFORE ZERO CREDENTIALS. The whole gallery surface makes
// no GitHub, OpenRouter, Gloo or YouVersion call — publish is "a single Postgres insert"
// (design-delta §7) and the listing is one query plus local URL signing. Three things
// make that a VERIFIED claim rather than an assertion:
//   1. `buildApp` here is wired with `auth` + `files` + `gallery` ONLY, so the github /
//      connections / ai-generation routes are not even registered and no provider client
//      is constructed;
//   2. the AuthService gets a THROWING YouVersion verifier, so any accidental sign-in
//      egress is a loud, immediate failure (the auth.e2e.ts idiom);
//   3. `getSignedUrl` signs LOCALLY — no S3 round trip — so even the presigning is
//      offline.
// Coupling a gallery spec to GitHub credentials is exactly the mistake the 34-E8
// decision warns against, so this file needs `postgres minio minio-init` and nothing
// else. There is also NO DBOS here: publish enqueues nothing (design-delta §7 lists
// gallery publish under "deliberately not workflows").
//
// LISTING DETERMINISM. `GET /v1/gallery` is the ONE endpoint in the system that is not
// scoped to a user, so every test that asserts an exact set or order scopes itself with a
// per-test `q=<nonce>` token embedded in its fixtures' text. That is not a workaround: it
// exercises the real free-text predicate at the same time.
//
// ...and it has ONE blind spot, which cost a shipped false badge. Because `q` is the
// isolation mechanism, every listing this spec looked at was a FILTERED listing — so all
// four of its `rank` assertions measured a position among search hits and called it a
// global ordinal, while three JSDocs promised the opposite. A property that is only true
// of the WHOLE listing cannot be tested through the isolation seam. E-G6b is the case that
// reads the unfiltered listing, and it asserts properties that survive foreign rows
// (each item's ordinal against an independently counted position) rather than an exact
// page. Any future claim about the global listing belongs there, not behind a nonce.

const APP_URL =
  process.env.DATABASE_URL ??
  "postgres://supagloo:supagloo@localhost:5432/supagloo";

const S3_CFG: S3EnvConfig = {
  internalEndpoint: process.env.S3_ENDPOINT ?? "http://minio:9000",
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  bucket: process.env.S3_BUCKET ?? "supagloo-dev",
  accessKey: process.env.S3_ACCESS_KEY ?? "supagloo",
  secretKey: process.env.S3_SECRET_KEY ?? "supagloo-dev",
};

/** The gallery's stream-url / thumbnail TTL (plan D13) — a service constant, not env. */
const STREAM_TTL_SECONDS = 120;
const HOUR_MS = 3_600_000;

const prisma: PrismaClient = createPrismaClient({ connectionString: APP_URL });
let s3: S3Client;
const putKeys: string[] = [];

/**
 * EVERY row this spec causes to exist, so `afterAll` can delete exactly its own.
 *
 * WHY THIS IS NOT OPTIONAL, and why the render / project / ai-generation specs get away
 * without it. Every OTHER surface in this api is scoped to a user, so a leftover row is
 * invisible to everybody else. `GET /v1/gallery` is the one endpoint that is not: it is a
 * GLOBAL projection of `visibility='public'`. This spec publishes dozens of items through
 * the real route, so leaving them behind does not merely bloat the database — it changes
 * what a later reader of the gallery sees.
 *
 * The concrete casualty was the nextjs UI spec, whose `beforeAll` asserts that the only
 * public items present are its own `e2e-gallery-`-prefixed fixtures (its grid assertions
 * are exact, so it cannot tolerate foreign rows). It threw and took all of its UI tests
 * down with a message that read like the developer's own database was dirty. The guard is
 * RIGHT and stays loud; the leak was here.
 *
 * Deleted by TRACKED ID, never by pattern: an id pattern would eventually match somebody
 * else's row, and this suite must not be able to delete data it did not create.
 */
const createdUserIds: string[] = [];
const createdProjectIds: string[] = [];
const createdVersionIds: string[] = [];
const createdRenderIds: string[] = [];

/** Full-page app (the production page size) and a 2-per-page app, so cursor pagination
 *  and rank continuity are exercised without seeding 25 renders. `pageSize` is a
 *  GalleryService constructor option precisely so this is possible (plan D5). */
let app: FastifyInstance;
let pagedApp: FastifyInstance;
let baseUrl: string;
let pagedUrl: string;

/** Fixed-width so two stamps can never be prefixes of one another. That matters: `q`
 *  search is a SUBSTRING match, so a nonce that is a prefix of another group's nonce
 *  would silently pull that group's items into a q-scoped assertion. */
const stamp = () =>
  `${Date.now().toString(36)}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
/** A single lowercase-alphanumeric word, unique per call — safe inside an ILIKE pattern
 *  and unambiguous as a `q` search token. */
const nonce = (tag: string) =>
  `zq${tag}${stamp()}`.toLowerCase().replace(/[^a-z0-9]/g, "");

beforeAll(async () => {
  s3 = makeS3Client(S3_CFG, "presign");
  await s3.send(new CreateBucketCommand({ Bucket: S3_CFG.bucket })).catch(() => {});

  const authService = new AuthService({
    prisma,
    // This suite must have ZERO YouVersion egress. Session mechanics go through
    // /v1/test/seed, which never calls verifyToken; a throwing verifier turns any
    // accidental sign-in egress into an immediate, named failure.
    verifyToken: async () => {
      throw new Error(
        "gallery.e2e.ts must make ZERO provider calls: the gallery surface has no " +
          "GitHub / OpenRouter / Gloo / YouVersion egress, and this spec must run " +
          "with no provider credential at all.",
      );
    },
    sessionTtlMs: SESSION_TTL_MS,
  });
  const filesService = new FilesService({ prisma, s3, bucket: S3_CFG.bucket });

  const makeGallery = (pageSize?: number) =>
    new GalleryService({
      prisma,
      presignPublic: (key, ttl) => filesService.presignPublicKey(key, ttl),
      pageSize,
    });

  const authDeps = {
    authService,
    env: { NODE_ENV: "test" as const, SUPAGLOO_ENABLE_TEST_SEED: "1" },
  };

  app = buildApp({
    auth: authDeps,
    files: { service: filesService },
    gallery: { service: makeGallery() },
  });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  pagedApp = buildApp({
    auth: authDeps,
    files: { service: filesService },
    gallery: { service: makeGallery(2) },
  });
  pagedUrl = await pagedApp.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);

/**
 * Run one teardown step, and NEVER let it abort the rest.
 *
 * Teardown that stops at the first failure is worse than no teardown: it leaves a partial
 * delete behind, which is precisely the state — public `GalleryItem` rows with no owner
 * story — that trips the next reader of the global listing. So every step reports and
 * continues, and the failures are printed rather than swallowed, because a teardown that
 * silently does nothing is how this leak survived a whole suite in the first place.
 */
async function teardownStep(what: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.error(`[gallery.e2e teardown] ${what} FAILED:`, error);
  }
}

afterAll(async () => {
  for (const key of putKeys) {
    await s3
      .send(new DeleteObjectCommand({ Bucket: S3_CFG.bucket, Key: key }))
      .catch(() => {});
  }

  // FK-safe order, child → parent. Every FK in the schema is `onDelete: Cascade`, so
  // deleting the users alone would in fact suffice — the explicit walk is deliberate: it
  // deletes exactly the rows this spec is accountable for, it does not depend on a schema
  // property that a future migration could relax, and each step's row count is separately
  // visible when one of them fails.
  //
  // Gallery items are matched by their PARENT ids rather than by a list of item ids,
  // because items are created by the REAL publish route from several call sites (some
  // tests call `publish` directly and read the 201 body) and a hand-kept list of item ids
  // would be one forgotten `push` away from leaking again. Every item this spec creates
  // belongs to a tracked render, project and user, so the OR cannot miss one.
  await teardownStep("galleryUpvote", () =>
    prisma.galleryUpvote.deleteMany({ where: { userId: { in: createdUserIds } } }),
  );
  await teardownStep("galleryItem", () =>
    prisma.galleryItem.deleteMany({
      where: {
        OR: [
          { renderJobId: { in: createdRenderIds } },
          { projectId: { in: createdProjectIds } },
          { ownerId: { in: createdUserIds } },
        ],
      },
    }),
  );
  await teardownStep("renderJob", () =>
    prisma.renderJob.deleteMany({ where: { id: { in: createdRenderIds } } }),
  );
  await teardownStep("projectVersion", () =>
    prisma.projectVersion.deleteMany({ where: { id: { in: createdVersionIds } } }),
  );
  await teardownStep("project", () =>
    prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }),
  );
  // Sessions are minted by `POST /v1/test/seed`, not by any helper here, so they are
  // deleted by their user rather than by id.
  await teardownStep("session", () =>
    prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }),
  );
  await teardownStep("user", () =>
    prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }),
  );

  if (app) await app.close();
  if (pagedApp) await pagedApp.close();
  if (s3) s3.destroy();
  await prisma.$disconnect().catch(() => {});
});

// ------------------------------------------------------------------------- helpers

interface SeededUser {
  token: string;
  userId: string;
}

/** Seed `n` users + sessions in ONE `POST /v1/test/seed` call (what E-U4 needs). */
async function seedUsers(tag: string, n: number): Promise<SeededUser[]> {
  const s = stamp();
  const users = Array.from({ length: n }, (_, i) => ({
    youversionUserId: `yv-gal-${tag}-${s}-${i}`,
    displayName: `Gallery E2E ${tag} ${i}`,
    email: `gal-${tag}-${s}-${i}@example.test`,
    avatarInitials: "GE",
    sessionToken: `gallery-e2e-${tag}-${s}-${i}`,
  }));
  const res = await fetch(`${baseUrl}/v1/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ users }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const seeded = body.users.map((u: any, i: number) => ({
    token: users[i].sessionToken,
    userId: u.user.id,
  }));
  createdUserIds.push(...seeded.map((u: SeededUser) => u.userId));
  return seeded;
}

const seedUser = async (tag: string) => (await seedUsers(tag, 1))[0];

async function seedProject(userId: string, tag: string) {
  const s = stamp();
  const project = await prisma.project.create({
    data: {
      slug: `gallery-${tag}-${s}`,
      ownerId: userId,
      name: `Gallery Project ${tag}`,
      repoOwner: "ashtable",
      repoName: `gallery-${tag}-${s}`,
      repoVisibility: "private",
      createdFrom: "blank",
      currentBranch: "v0.0.1",
    },
  });
  const version = await prisma.projectVersion.create({
    data: {
      projectId: project.id,
      semver: "0.0.1",
      branchName: "v0.0.1",
      state: "published",
      headCommitSha: "0".repeat(40),
      changedFiles: [],
    },
  });
  createdProjectIds.push(project.id);
  createdVersionIds.push(version.id);
  return { projectId: project.id, versionId: version.id };
}

/** Bytes PUT for each render, so a stream-url / thumbnail round trip can assert the
 *  EXACT payload rather than merely "some 200". */
const outputBytes = new Map<string, string>();
const thumbBytes = new Map<string, string>();

/**
 * A `completed`, publishable RenderJob plus its real MinIO objects. Written with direct
 * Prisma + a real PUT rather than by driving a render: task 36's real Remotion render is
 * proven in the dbos repo, and re-running one here would add ~10 minutes for zero new
 * information about the gallery.
 */
async function seedCompletedRender(
  user: SeededUser,
  project: { projectId: string; versionId: string },
  tag: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const id = `gal-e2e-${tag}-${stamp()}`;
  createdRenderIds.push(id);
  await prisma.renderJob.create({
    data: {
      id,
      projectId: project.projectId,
      versionId: project.versionId,
      userId: user.userId,
      status: "completed",
      framesDone: 900,
      framesTotal: 900,
      width: 320,
      height: 568,
      fps: 30,
      aspectRatio: "9:16",
      codec: "h264",
      outputAssetKey: buildRenderOutputKey(id),
      thumbnailAssetKey: buildRenderThumbnailKey(id),
      runInBackground: false,
      completedAt: new Date(),
      ...over,
    },
  });

  if ((over.status ?? "completed") === "completed") {
    const video = `gallery-video-bytes-${id}`;
    const thumb = `gallery-thumb-bytes-${id}`;
    outputBytes.set(id, video);
    thumbBytes.set(id, thumb);
    for (const [key, body, type] of [
      [buildRenderOutputKey(id), video, "video/mp4"],
      [buildRenderThumbnailKey(id), thumb, "image/jpeg"],
    ] as const) {
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_CFG.bucket,
          Key: key,
          Body: body,
          ContentType: type,
        }),
      );
      putKeys.push(key);
    }
  }
  return id;
}

function request(
  base: string,
  path: string,
  token?: string,
  init: { method?: string; body?: unknown } = {},
) {
  return fetch(`${base}/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const api = (path: string, token?: string, init?: { method?: string; body?: unknown }) =>
  request(baseUrl, path, token, init);
const paged = (
  path: string,
  token?: string,
  init?: { method?: string; body?: unknown },
) => request(pagedUrl, path, token, init);

function publishBody(over: Record<string, unknown> = {}) {
  return {
    title: "He Who Dwells",
    description: "Psalm 91 in nine scenes.",
    scriptureReference: "Psalm 91:1",
    translation: "BSB",
    visibility: "public",
    ...over,
  };
}

async function publish(
  token: string,
  renderJobId: string,
  over: Record<string, unknown> = {},
) {
  const res = await api(`/renders/${renderJobId}/gallery`, token, {
    method: "POST",
    body: publishBody(over),
  });
  return res;
}

/** Publish and require success, returning the item DTO. */
async function publishOk(
  token: string,
  renderJobId: string,
  over: Record<string, unknown> = {},
) {
  const res = await publish(token, renderJobId, over);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()).item;
}

async function listItems(
  query: string,
  token?: string,
  fetcher: typeof api = api,
): Promise<{ items: any[]; nextCursor: string | null }> {
  const res = await fetcher(`/gallery${query}`, token);
  expect(res.status, `${query} → ${res.status}`).toBe(200);
  return res.json();
}

const idsOf = (items: any[]) => items.map((i) => i.id);

/** The three sorts, as the wire spells them. */
const SORT_NAMES = ["popular", "newest", "trending"] as const;

/** Substrings that must NEVER appear in an error body on this surface: a Postgres SQLSTATE, a
 *  Prisma error code or brand, the raw driver text, or an absolute source path. One list, used
 *  by every hostile-input spec.
 *
 *  DELIBERATELY NOT A BLANKET `FST_ERR` BAN, and the distinction is measured. Fastify's own
 *  CLIENT-error codes are part of its public contract and already appear on this surface:
 *  `GET /v1/gallery/%zz` is answered by the ROUTER, before any route or schema exists, with
 *  `400 {"error":"Bad Request","code":"FST_ERR_BAD_URL", …}`. That names Fastify, not the
 *  database, the driver or the filesystem — nothing an attacker learns from it. What must never
 *  appear is `FST_ERR_RESPONSE_SERIALIZATION`, which is the one Fastify code the audit found on
 *  a **500** (a forged ordinal that broke the reply's own schema); `src/error-handler.ts`
 *  generifies every 500, so its presence anywhere would mean that handler had regressed. */
const LEAKS = [
  "22007",
  "22008",
  "22009",
  "22021",
  "P2010",
  "P2023",
  "prisma",
  "Prisma",
  "timestamp with time zone",
  "byte sequence",
  "DriverAdapterError",
  "FST_ERR_RESPONSE_SERIALIZATION",
  "/Users/",
  "src/gallery",
] as const;

/** The field names a decoded cursor actually carries, read back through the REAL codec.
 *  E-G16's coverage self-check uses this so "the matrix covers every cursor field" is a fact
 *  about `decodeCursor` rather than a hand-kept list that can fall behind it. */
function decodedFieldsOf(payload: unknown): Record<string, unknown> {
  const raw = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const decoded = decodeCursor(raw);
  if (!decoded.ok) {
    throw new Error(`decodedFieldsOf needs a VALID cursor: ${decoded.reason}`);
  }
  return decoded.cursor as unknown as Record<string, unknown>;
}

/** Seed one user + project and publish `specs.length` items sharing one `q` nonce. */
async function seedGroup(
  tag: string,
  specs: Array<{ over?: Record<string, unknown>; upvoteCount?: number; ageHours?: number }>,
): Promise<{
  token: string;
  user: SeededUser;
  groupNonce: string;
  items: any[];
  renderIds: string[];
  now: Date;
}> {
  const user = await seedUser(tag);
  const project = await seedProject(user.userId, tag);
  const groupNonce = nonce(tag);
  const now = new Date();

  const items: any[] = [];
  const renderIds: string[] = [];
  for (const [i, spec] of specs.entries()) {
    const renderId = await seedCompletedRender(user, project, `${tag}${i}`, {});
    renderIds.push(renderId);
    const item = await publishOk(user.token, renderId, {
      title: `Item ${i} ${groupNonce}`,
      description: `member of ${groupNonce}`,
      ...(spec.over ?? {}),
    });
    // Shape the two ORDERING inputs directly. `publishedAt` defaults to now() and
    // `upvoteCount` to 0, and there is no endpoint that backdates either — the sorts
    // themselves are what is under test, not how the values got there.
    if (spec.upvoteCount !== undefined || spec.ageHours !== undefined) {
      items.push(
        await prisma.galleryItem.update({
          where: { id: item.id },
          data: {
            ...(spec.upvoteCount !== undefined
              ? { upvoteCount: spec.upvoteCount }
              : {}),
            ...(spec.ageHours !== undefined
              ? { publishedAt: new Date(now.getTime() - spec.ageHours * HOUR_MS) }
              : {}),
          },
        }),
      );
    } else {
      items.push(item);
    }
  }
  return { token: user.token, user, groupNonce, items, renderIds, now };
}

/** Walk a q-scoped listing to exhaustion on the 2-per-page app. */
async function walkPages(
  query: string,
  token?: string,
): Promise<{ pages: any[][]; cursors: string[] }> {
  const pages: any[][] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page = await listItems(`${query}${suffix}`, token, paged);
    pages.push(page.items);
    if (page.nextCursor === null) return { pages, cursors };
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate within 20 pages");
}

// ==================================================================== row 39 specs

describe("e2e: publish", () => {
  it("E-G1: a completed render publishes (201) and appears in GET /v1/gallery with NO Authorization header at all", async () => {
    const user = await seedUser("pub");
    const project = await seedProject(user.userId, "pub");
    const renderId = await seedCompletedRender(user, project, "pub");
    const token = nonce("pub");

    const res = await publish(user.token, renderId, {
      title: `Shelter of the Most High ${token}`,
    });
    expect(res.status).toBe(201);
    const item = (await res.json()).item;
    expect(item.renderJobId).toBe(renderId);
    expect(item.projectId).toBe(project.projectId);
    expect(item.visibility).toBe("public");
    expect(item.upvoteCount).toBe(0);
    expect(item.viewerHasUpvoted).toBe(false);
    expect(item.durationSeconds).toBe(30); // 900 frames / 30 fps
    expect(item.owner.displayName).toContain("Gallery E2E");
    // Deliberate DTO omissions (plan §3.2): a public consumer must go through stream-url.
    expect(item.videoAssetKey).toBeUndefined();
    expect(item.ownerId).toBeUndefined();
    expect(item.viewCount).toBeUndefined();

    // THE HEADLINE ACCEPTANCE: no auth header whatsoever.
    const anon = await listItems(`?q=${token}`);
    expect(idsOf(anon.items)).toEqual([item.id]);
    // NO rank: this listing carries a `q`, and an ordinal among search hits is not a
    // position in the popular ordering. E-G6b is where rank is actually asserted.
    expect(anon.items[0].rank).toBeNull();
    expect(anon.items[0].viewerHasUpvoted).toBe(false);
    expect(typeof anon.items[0].thumbnailUrl).toBe("string");
    expect(anon.nextCursor).toBeNull();

    // ...and the bare, parameter-free public listing is reachable too.
    const bare = await listItems("");
    expect(bare.items.length).toBeGreaterThan(0);
  });

  it("E-G2: an incomplete render 409s render_not_publishable; another user's render 404s", async () => {
    const owner = await seedUser("gate-owner");
    const other = await seedUser("gate-other");
    const ownerProject = await seedProject(owner.userId, "gate-owner");
    const otherProject = await seedProject(other.userId, "gate-other");

    const encoding = await seedCompletedRender(owner, ownerProject, "encoding", {
      status: "encoding",
      outputAssetKey: null,
      thumbnailAssetKey: null,
      framesTotal: 0,
      completedAt: null,
    });
    const notReady = await publish(owner.token, encoding);
    expect(notReady.status).toBe(409);
    expect((await notReady.json()).error).toBe("render_not_publishable");

    const foreign = await seedCompletedRender(other, otherProject, "foreign");
    const denied = await publish(owner.token, foreign);
    expect(denied.status).toBe(404);
    expect((await denied.json()).error).toBe("not_found");

    // An unknown render id is indistinguishable from a foreign one.
    const unknown = await publish(owner.token, "no-such-render");
    expect(unknown.status).toBe(404);

    // ...and anonymous publish is a 401, not a 404.
    const anon = await api(`/renders/${foreign}/gallery`, undefined, {
      method: "POST",
      body: publishBody(),
    });
    expect(anon.status).toBe(401);

    expect(await prisma.galleryItem.count({ where: { renderJobId: encoding } })).toBe(0);
    expect(await prisma.galleryItem.count({ where: { renderJobId: foreign } })).toBe(0);
  });

  it("E-G3: publishing the same render twice 409s already_published, and the FIRST item is unchanged", async () => {
    const user = await seedUser("dup");
    const project = await seedProject(user.userId, "dup");
    const renderId = await seedCompletedRender(user, project, "dup");

    const first = await publishOk(user.token, renderId, { title: "First Title" });

    const again = await publish(user.token, renderId, {
      title: "Second Title",
      description: "an edit that must not take",
      visibility: "unlisted",
    });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("already_published");

    // The second call carried a different title/description/visibility, so a silent 200
    // would have looked like the edit took.
    const after = await api(`/gallery/${first.id}`);
    expect(after.status).toBe(200);
    const item = (await after.json()).item;
    expect(item.title).toBe("First Title");
    expect(item.description).toBe("Psalm 91 in nine scenes.");
    expect(item.visibility).toBe("public");
    expect(await prisma.galleryItem.count({ where: { renderJobId: renderId } })).toBe(1);
  });

  it("E-G4: an underivable scriptureReference 422s scripture_book_underivable and creates NO row", async () => {
    const user = await seedUser("underiv");
    const project = await seedProject(user.userId, "underiv");

    for (const reference of ["a poem", "Book of Mormon 1:1", "Theodore"]) {
      expect(deriveScriptureBook(reference), reference).toBeNull();
      const renderId = await seedCompletedRender(user, project, "underiv");
      const res = await publish(user.token, renderId, {
        scriptureReference: reference,
      });
      expect(res.status, reference).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("scripture_book_underivable");
      // The message must name the offending reference so the client can fix it.
      expect(body.message).toContain(reference);
      expect(
        await prisma.galleryItem.count({ where: { renderJobId: renderId } }),
        reference,
      ).toBe(0);
    }
  });

  it("E-G5: scriptureBook is persisted from the reference — an INTERNAL column that nothing filters on", async () => {
    const user = await seedUser("book");
    const project = await seedProject(user.userId, "book");
    const groupNonce = nonce("book");

    const cases: Array<[string, string]> = [
      ["GENESIS 1:1–4", "GEN"], // en dash
      ["1 Corinthians 13", "1CO"],
    ];
    const published: any[] = [];
    for (const [reference, code] of cases) {
      const renderId = await seedCompletedRender(user, project, "book");
      const item = await publishOk(user.token, renderId, {
        title: `Book case ${groupNonce}`,
        scriptureReference: reference,
      });
      expect(item.scriptureBook, reference).toBe(code);
      // ...and it really is on the row, not just in the reply.
      const row = await prisma.galleryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(row.scriptureBook, reference).toBe(code);
      // The reference renders VERBATIM on the card; only the derived code is coarsened.
      expect(item.scriptureReference).toBe(reference);
      published.push(item);
    }

    // THE SCOPE GUARD (plan §5.2, 2026-07-26): there is NO book filter. `book=` is not a
    // query parameter, so supplying one must be IGNORED — both items still come back.
    // Which books exist is a property of the TRANSLATION and YouVersion is the authority
    // on it, so a facet built from a canon hardcoded here was the wrong design.
    const filtered = await listItems(`?q=${groupNonce}&book=GEN`);
    expect(idsOf(filtered.items).sort()).toEqual(idsOf(published).sort());
  });
});

// ------------------------------------------------------------------ sorts + trending

/** Shared by E-G6 and E-G7: one seeded set with hand-computed orderings. */
let sortGroup: Awaited<ReturnType<typeof seedGroup>> | undefined;
const SORT_SPECS = [
  { upvoteCount: 500, ageHours: 3 }, // 0: trending ≈ 44.81
  { upvoteCount: 0, ageHours: 1 / 60 }, // 1: ≈ 0.3492  (1 minute old)
  { upvoteCount: 100, ageHours: 200 }, // 2: ≈ 0.0352
  { upvoteCount: 10, ageHours: 10 }, // 3: ≈ 0.2646
  { upvoteCount: 30, ageHours: 50 }, // 4: ≈ 0.0827
  { upvoteCount: 1, ageHours: 1 }, // 5: ≈ 0.3849
];

describe("e2e: the three sorts", () => {
  it("E-G6: newest / popular / trending order one seeded set THREE different ways", async () => {
    sortGroup = await seedGroup("sorts", SORT_SPECS);
    const { groupNonce, items } = sortGroup;
    const byIndex = (i: number) => items[i].id;

    const newest = await listItems(`?q=${groupNonce}&sort=newest`);
    expect(idsOf(newest.items)).toEqual([1, 5, 0, 3, 4, 2].map(byIndex));

    const popular = await listItems(`?q=${groupNonce}&sort=popular`);
    expect(idsOf(popular.items)).toEqual([0, 2, 4, 3, 5, 1].map(byIndex));

    const trending = await listItems(`?q=${groupNonce}&sort=trending`);
    // Hand-computed with TRENDING = {voteOffset 1, ageOffsetHours 2, gravity 1.5}.
    expect(idsOf(trending.items)).toEqual([0, 5, 1, 3, 4, 2].map(byIndex));
    // THE P5 PROPERTY, end to end: trending is a genuinely third ordering. This is what
    // catches gravity→0 (trending ≡ popular) and a vote-offset-dominated formula
    // (trending ≡ newest).
    expect(idsOf(trending.items)).not.toEqual(idsOf(popular.items));
    expect(idsOf(trending.items)).not.toEqual(idsOf(newest.items));
    // rank is null on ALL THREE of these listings — and, importantly, for two different
    // reasons that this case cannot tell apart. `newest`/`trending` are not the popular
    // ordering; and every listing here is `q`-scoped, which is not an ordering at all. The
    // comment that used to sit on this line claimed these assertions demonstrated a GLOBAL
    // property, three lines above a `popular` assertion that only passed because it did
    // not. E-G6b is the case that separates the two.
    expect(popular.items.every((i) => i.rank === null)).toBe(true);
    expect(trending.items.every((i) => i.rank === null)).toBe(true);
    expect(newest.items.every((i) => i.rank === null)).toBe(true);
  }, 120_000);

  it("E-G6b: rank is the position in the UNFILTERED popular ordering — a searched listing has none", async () => {
    // THE CASE THAT DID NOT EXIST, and the reason a false badge shipped. `q` is how this
    // whole spec isolates its fixtures from a listing that is global by design, so all four
    // of its rank assertions ran against `?q=<nonce>` — i.e. every listing the spec ever
    // inspected was a FILTERED one. The ILIKE predicate sits in the same `WHERE` as the
    // `ORDER BY` and the `LIMIT`, so `rank` was a position among the HITS: type anything
    // into the gallery search box and the top match wore "#1".
    //
    // This case therefore has to read the UNFILTERED listing, which is global and carries
    // every other test's rows. So it asserts PROPERTIES that survive foreign data rather
    // than an exact page, and it computes each item's TRUE position with an independent
    // query instead of re-deriving it from the response it is checking.
    const decoy = await seedGroup("rankdecoy", [{ upvoteCount: 900_000 }]);
    const group = await seedGroup("rankglobal", [
      { upvoteCount: 7 },
      { upvoteCount: 6 },
      { upvoteCount: 5 },
    ]);

    /** The item's real 1-based place in the global `popular` ordering, counted in SQL
     *  against the SAME `ORDER BY "upvoteCount" DESC, "id" DESC` the builder emits. */
    const truePosition = async (item: { id: string; upvoteCount: number }) =>
      1 +
      (await prisma.galleryItem.count({
        where: {
          visibility: "public",
          OR: [
            { upvoteCount: { gt: item.upvoteCount } },
            { upvoteCount: item.upvoteCount, id: { gt: item.id } },
          ],
        },
      }));

    // 1. THE BUG, stated as a number. The group's top item is the FIRST hit for its nonce,
    //    so the old code badged it "#1"; its real place in the ordering is strictly worse,
    //    because the decoy's 900 000 votes are ahead of it. A rank on a searched listing is
    //    not merely imprecise — it is a different quantity.
    const filtered = await listItems(`?q=${group.groupNonce}&sort=popular`);
    expect(idsOf(filtered.items)).toEqual(idsOf(group.items));
    expect(await truePosition(group.items[0])).toBeGreaterThan(1);
    expect(filtered.items.map((i) => i.rank)).toEqual([null, null, null]);

    // 2. The UNFILTERED listing DOES rank, and the ordinal is the item's true position —
    //    checked per item against the independent count, not against its own index.
    const whole = await listItems("?sort=popular");
    expect(whole.items.length).toBeGreaterThan(0);
    for (const [index, item] of whole.items.entries()) {
      expect(item.rank, `${item.id} at index ${index}`).toBe(await truePosition(item));
    }
    // ...which for page one means exactly 1..n, contiguous and strictly increasing.
    expect(whole.items.map((i) => i.rank)).toEqual(
      whole.items.map((_, index) => index + 1),
    );

    // 3. Continuity across a page boundary, on the unfiltered listing this time: the
    //    2-per-page app's second page must CONTINUE the ordering, not restart at 1. (This
    //    is the proof E-G8 used to carry against a q-scoped walk, where it was a statement
    //    about five hits rather than about the gallery.)
    const first = await listItems("?sort=popular", undefined, paged);
    expect(first.items.map((i) => i.rank)).toEqual([1, 2]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listItems(
      `?sort=popular&cursor=${encodeURIComponent(first.nextCursor!)}`,
      undefined,
      paged,
    );
    expect(second.items.map((i) => i.rank)).toEqual([3, 4]);
    for (const item of [...first.items, ...second.items]) {
      expect(item.rank, item.id).toBe(await truePosition(item));
    }

    // 4. A BLANK `q` is ABSENT, not a filter — the builder emits no predicate for it — so
    //    it must still rank. The UI's model always appends `q=`, so gating on the raw
    //    parameter instead of the parsed term would have dropped every badge in the product.
    const blank = await listItems("?sort=popular&q=%20%20");
    expect(idsOf(blank.items)).toEqual(idsOf(whole.items));
    expect(blank.items.map((i) => i.rank)).toEqual(whole.items.map((i) => i.rank));

    // The decoy exists only to make (1)'s inequality CERTAIN rather than incidental: with
    // 900 000 votes it is ahead of the group's 7 in the ordering whatever else the gallery
    // holds, so `truePosition(group.items[0]) > 1` cannot pass by luck. Measured, not
    // assumed — and stated as a comparison so it survives a busier gallery.
    expect(await truePosition(decoy.items[0])).toBeLessThan(
      await truePosition(group.items[0]),
    );
  }, 120_000);

  it("E-G7: the SQL trending expression agrees with the pure TS twin, on the epoch the cursor froze", async () => {
    if (!sortGroup) throw new Error("E-G6 must run first — it seeds the shared set");
    const { groupNonce, items } = sortGroup;

    // Walk the 2-per-page app so a cursor — and therefore an epoch — actually exists.
    const { pages, cursors } = await walkPages(`?q=${groupNonce}&sort=trending`);
    const walked = pages.flatMap(idsOf);
    expect(walked).toHaveLength(SORT_SPECS.length);
    expect(new Set(walked).size).toBe(SORT_SPECS.length);
    expect(cursors.length).toBeGreaterThan(0);

    const first = decodeCursor(cursors[0]);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(typeof first.cursor.t).toBe("string");
    const epoch = new Date(first.cursor.t!);

    // Read the rows back so the twin scores EXACTLY what Postgres scored.
    const rows = await prisma.galleryItem.findMany({
      where: { id: { in: items.map((i) => i.id) } },
      select: { id: true, upvoteCount: true, publishedAt: true },
    });
    expect(sortByTrendingDesc(rows, epoch).map((r) => r.id)).toEqual(walked);

    // Every cursor in the run carries the SAME epoch — that is what makes the age term
    // constant across pages and keeps trending no worse than popular for stability.
    for (const raw of cursors) {
      const decoded = decodeCursor(raw);
      if (!decoded.ok) throw new Error("a minted cursor failed to decode");
      expect(decoded.cursor.t).toBe(first.cursor.t);
    }
  }, 120_000);
});

// --------------------------------------------------------------- cursor pagination

let pageOneCursor: string | undefined;

describe("e2e: cursor pagination", () => {
  it("E-G8: a 2-per-page walk over 5 items yields 5 distinct ids, no duplicates and a null final cursor", async () => {
    const group = await seedGroup(
      "page",
      [50, 40, 30, 20, 10].map((upvoteCount) => ({ upvoteCount })),
    );
    const { groupNonce, items } = group;

    const { pages, cursors } = await walkPages(`?q=${groupNonce}&sort=popular`);
    const walked = pages.flatMap(idsOf);

    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(walked).toEqual(idsOf(items)); // seeded in descending upvoteCount order
    expect(new Set(walked).size).toBe(5);
    // `nextCursor === null` must mean GENUINELY exhausted, which is what lets the UI hide
    // "Load more" honestly — hence the pageSize+1 probe.
    expect(cursors).toHaveLength(2);

    // This walk is `q`-scoped — that is how it gets a deterministic 5-item population out
    // of a global listing — so it carries NO ranks, and the cursor's ordinal continuity is
    // proven on the unfiltered listing by E-G6b instead. The assertion that used to live
    // here read `[1, 2, 3, 4, 5]` and was described as "a direct test of cursor
    // correctness"; it was a test that five search hits are numbered one to five.
    expect(pages.flatMap((p) => p.map((i: any) => i.rank))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);

    pageOneCursor = cursors[0];
  }, 120_000);

  it("E-G8b: `newest` paginates too — its cursor key travels as an ISO STRING and must still compare as a timestamptz", async () => {
    // `newest` is the ONE sort whose cursor key is not a number: it leaves Postgres as a
    // `Date`, travels through JSON as an ISO-8601 STRING, and comes back to be compared
    // against a `timestamptz` column — so it is the one keyset predicate whose correctness
    // depends on parameter TYPE RESOLUTION rather than on SQL text, which is exactly what a
    // construction-only unit test cannot see. E-G8 walks `popular` (an int key) and E-G7
    // walks `trending` (a double key); before this case the third was never walked at all.
    //
    // Measured while writing it: the walk passes with the `::timestamptz` cast REMOVED too
    // (Postgres infers the unspecified parameter's type from the column), so this is not a
    // regression test for that cast — it is the first end-to-end proof that `newest`
    // paginates, cursor round trip included.
    const group = await seedGroup(
      "pagenew",
      [5, 4, 3, 2, 1].map((ageHours) => ({ ageHours })),
    );
    const { groupNonce, items } = group;

    const { pages, cursors } = await walkPages(`?q=${groupNonce}&sort=newest`);
    const walked = pages.flatMap(idsOf);

    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    // Seeded oldest-first (5 h → 1 h old), so newest-first is exactly the reverse.
    expect(walked).toEqual([...idsOf(items)].reverse());
    expect(new Set(walked).size).toBe(5);
    expect(cursors).toHaveLength(2);
    // No rank under any sort but popular, on every page.
    expect(pages.flatMap((p) => p.map((i: any) => i.rank))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  }, 120_000);

  it("E-G9: a cursor minted under `popular` replayed with `sort=newest` ⇒ 400 invalid_cursor", async () => {
    if (!pageOneCursor) throw new Error("E-G8 must run first — it mints the cursor");

    const res = await paged(
      `/gallery?sort=newest&cursor=${encodeURIComponent(pageOneCursor)}`,
    );
    // Honouring it would page a DIFFERENT ordering and silently skip or duplicate large
    // ranges, so changing the sort must restart pagination.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_cursor");

    for (const bad of ["zzz", "", "e30", "%%%"]) {
      const garbage = await paged(`/gallery?cursor=${encodeURIComponent(bad)}`);
      // A blank cursor means "page one" (a UI that always appends the parameter must not
      // 400); anything else that will not decode is a 400.
      expect(garbage.status, JSON.stringify(bad)).toBe(bad === "" ? 200 : 400);
    }

    // ...and the same cursor still works under the sort it was minted for.
    const ok = await paged(
      `/gallery?sort=popular&cursor=${encodeURIComponent(pageOneCursor)}`,
    );
    expect(ok.status).toBe(200);
  });

  it("E-G16: EVERY field of a structurally valid cursor, under EVERY sort — never a 5xx, and every unambiguously hostile value is a 400 that leaks nothing", async () => {
    // THE TEST THAT WAS FALSIFIED, AND WHY. Its previous version claimed in its own title that
    // "a structurally valid cursor with a hostile payload" was closed, then drove eleven
    // payloads that varied only `k`, `t` and `n` — every one hardcoding `i: "zzz"`. The FOURTH
    // bound value of the same keyset predicate was never driven, and a cursor carrying
    // `"i": "<NUL>"` was still an UNAUTHENTICATED 500 (P2010 → SQLSTATE 22021) under all three
    // sorts. A test whose title claims a CLASS has to enumerate the class.
    //
    // It is now a MATRIX over the cursor's five fields × three sorts, in two layers, because
    // the two questions have different answers per cell:
    //
    //   LAYER 1 — the invariant, over the WHOLE cross product: never a 5xx, and never an
    //   internal detail on the wire. This is the property the audit is about and it holds for
    //   every cell regardless of whether the value is legal.
    //
    //   LAYER 2 — exact status, over the values that are UNAMBIGUOUSLY hostile for that field
    //   under that sort: 400 + `invalid_cursor`.
    //
    // The split is not a hedge; it is the contract. Some cells are legitimately 200 and a test
    // demanding 400 for them would be asserting a bug:
    //   - `k: 42` is a PERFECTLY VALID `popular` key (an integer inside int4) and a valid
    //     `trending` key (a finite double). It is only hostile under `newest`.
    //   - `t` is READ ONLY under `trending` (`decodeCursor` never looks at `c.t` for the two
    //     column sorts, and drops it from the decoded cursor), so a hostile `t` on a `popular`
    //     cursor is IGNORED, not rejected — the same as any other unknown JSON field. Layer 1
    //     is what proves that ignoring it is safe.
    const mint = (payload: unknown) =>
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const CH = (...codes: number[]) => String.fromCodePoint(...codes);

    // A REAL published item, so the positive control is a genuine 200 and `i` carries the shape
    // a client is actually handed.
    const group = await seedGroup("hostilecursor", [{}, {}]);
    const realId: string = group.items[0].id;

    const validKey = (sort: string): unknown =>
      sort === "newest" ? "2026-07-26T12:00:00.000Z" : sort === "popular" ? 5 : 1.5;
    const valid = (sort: string, over: Record<string, unknown> = {}) => ({
      s: sort,
      k: validKey(sort),
      i: realId,
      n: 1,
      ...(sort === "trending" ? { t: "2026-07-26T12:00:00.000Z" } : {}),
      ...over,
    });

    // ANTI-VACUITY GUARD, first: the all-valid cursor must be a 200 under every sort. Without
    // it the whole matrix could pass because every cursor was rejected for some unrelated
    // reason (a sort mismatch, say), proving nothing about the fields at all.
    for (const sort of SORT_NAMES) {
      const control = await api(
        `/gallery?sort=${sort}&cursor=${encodeURIComponent(mint(valid(sort)))}`,
      );
      expect(control.status, `positive control sort=${sort} → ${await control.text()}`).toBe(
        200,
      );
    }

    /** Strings the shared text rule (`src/postgres-text.ts`) refuses. Hostile in ANY field. */
    const HOSTILE_TEXT: Array<[string, unknown]> = [
      ["NUL", CH(0)], // the 22021 case — the one value Postgres refuses outright
      ["NUL embedded", `x${CH(0)}y`],
      ["NUL appended to a REAL id", `${realId}${CH(0)}`], // what a client would actually forge
      ["VT", CH(0x0b)], // VT and FF get their own cases: `trim()` hides exactly these two
      ["FF", CH(0x0c)],
      ["ESC", CH(0x1b)],
      ["DEL", CH(0x7f)],
      ["unpaired surrogate", CH(0xd800)], // never carried as sent — transcoded to U+FFFD
    ];
    /** Values of the wrong SHAPE for any of the five fields. */
    const WRONG_SHAPE: Array<[string, unknown]> = [
      ["empty string", ""],
      ["null", null],
      ["true", true],
      ["object", { a: 1 }],
      ["array", ["a"]],
      ["numeric string", "42"],
    ];
    /** Timestamps V8 or a human accepts and Postgres's `timestamptz` parser does not. Every
     *  SQLSTATE below was observed as a real unauthenticated 500 at d319046 or measured against
     *  the real database while sweeping the grammar's own extremes. */
    const HOSTILE_TIMESTAMPS: Array<[string, unknown]> = [
      ["bare year (22007)", "2026"],
      ["human month/year (22007)", "Jan 2000"],
      ["Feb 30 (22008)", "2020-02-30T00:00:00Z"],
      ["Feb 29 of a non-leap year", "2023-02-29T00:00:00Z"],
      ["V8 Date#toString (22007)", "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)"],
      ["expanded negative year (22009)", "-271821-04-20T00:00:00.000Z"],
      ["expanded positive year", "+275760-09-13T00:00:00.000Z"],
      ["year zero (22008)", "0000-01-01T00:00:00Z"],
      ["offset +16:00 (22009)", "2026-07-26T12:00:00+16:00"],
      ["offset +14:01", "2026-07-26T12:00:00+14:01"],
      ["hour 24", "2026-01-01T24:00:00Z"],
      ["minute 60", "2026-01-01T00:60:00Z"],
      ["space separator", "2026-07-26 12:00:00Z"],
      ["date only", "2026-07-26"],
      ["Postgres literal infinity", "infinity"],
      ["Postgres literal -infinity", "-infinity"],
      ["Postgres literal now", "now"],
      ["Postgres literal epoch", "epoch"],
      ["valid instant + NUL", `2026-07-26T12:00:00Z${CH(0)}`],
    ];
    /** Ordinals outside "a safe integer within the page-position bound". */
    const HOSTILE_ORDINALS: Array<[string, unknown]> = [
      ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER], // FST_ERR_RESPONSE_SERIALIZATION at d319046
      ["MAX_SAFE_INTEGER + 2", Number.MAX_SAFE_INTEGER + 2],
      ["1e21", 1e21],
      ["1e308", 1e308],
      ["negative", -1],
      ["fractional", 1.5],
      ["past the ordinal ceiling", 1_000_001],
    ];
    const HOSTILE_SORTS: Array<[string, unknown]> = [
      ["unknown sort", "hot"],
      ["wrong case", "Popular"],
      ["sort + NUL", `popular${CH(0)}`],
      ["sort with SQL appended", 'popular; DROP TABLE "GalleryItem"'],
    ];

    /** LAYER 2 — for each field, the values that MUST be a 400, and under which sorts. */
    const MUST_REJECT: Array<[string, Array<[string, unknown]>, readonly string[]]> = [
      // N1, the finding: `i` is the fourth bound parameter of the keyset predicate, and the
      // whole text class must be refused under every sort.
      ["i", [...HOSTILE_TEXT, ["empty string", ""], ["null", null], ["number", 5], ["object", { a: 1 }], ["array", ["a"]]], SORT_NAMES],
      // `n` never has a legal value in this corpus, under any sort.
      ["n", [...HOSTILE_ORDINALS, ...WRONG_SHAPE, ...HOSTILE_TEXT], SORT_NAMES],
      // `s` must EQUAL the request's sort, so nothing here is ever legal.
      ["s", [...HOSTILE_SORTS, ...WRONG_SHAPE, ...HOSTILE_TEXT], SORT_NAMES],
      // `k` under `newest` is a STRICT ISO instant, so every hostile timestamp, every number
      // and every non-instant string is refused.
      ["k", [...HOSTILE_TIMESTAMPS, ...WRONG_SHAPE, ...HOSTILE_TEXT, ["a number", 42], ["a float", 1.5]], ["newest"]],
      // `k` under `popular` is an int4 INTEGER: strings, shapes, floats and overflow are out.
      ["k", [...HOSTILE_TIMESTAMPS, ...WRONG_SHAPE, ...HOSTILE_TEXT, ["fractional", 1.5], ["int4 overflow", 2_147_483_648], ["int4 underflow", -2_147_483_649]], ["popular"]],
      // `k` under `trending` is any FINITE number, so only non-numbers are out.
      ["k", [...HOSTILE_TIMESTAMPS, ...WRONG_SHAPE, ...HOSTILE_TEXT], ["trending"]],
      // `t` is required and grammar-checked under `trending` ONLY.
      ["t", [...HOSTILE_TIMESTAMPS, ...WRONG_SHAPE, ...HOSTILE_TEXT], ["trending"]],
    ];

    // COVERAGE SELF-CHECK: the fields exercised are exactly the fields the REAL codec returns
    // for a valid trending cursor (the one sort carrying all five). A cursor field nobody adds
    // here makes this fail rather than silently going untested — which is the specific way the
    // previous version of this test became a false claim.
    expect([...new Set(MUST_REJECT.map(([field]) => field))].sort()).toEqual(
      Object.keys(decodedFieldsOf(valid("trending"))).sort(),
    );

    let rejected = 0;
    for (const [field, corpus, sorts] of MUST_REJECT) {
      for (const sort of sorts) {
        for (const [label, value] of corpus) {
          const res = await api(
            `/gallery?sort=${sort}&cursor=${encodeURIComponent(mint(valid(sort, { [field]: value })))}`,
          );
          const body = await res.text();
          const tag = `sort=${sort} ${field}=${label}`;
          rejected += 1;
          expect(res.status, `${tag} → ${res.status} ${body}`).toBe(400);
          expect(JSON.parse(body).error, tag).toBe("invalid_cursor");
          for (const leak of LEAKS) {
            expect(body, `${tag} leaked ${leak}`).not.toContain(leak);
          }
        }
      }
    }
    // The matrix is not empty and has not quietly shrunk. 293 exact-status probes at the time
    // of writing; the floor is what guards against a corpus that silently loses entries.
    expect(rejected).toBeGreaterThan(250);

    // LAYER 1 — the invariant over the WHOLE cross product, legal cells included. This is what
    // covers the cells layer 2 deliberately does not assert an exact status for (a `k` of 42
    // under `popular`, a hostile `t` on a column sort), and it is the property that was
    // violated at 5958b9f.
    const EVERY_VALUE = [
      ...HOSTILE_TEXT,
      ...WRONG_SHAPE,
      ...HOSTILE_TIMESTAMPS,
      ...HOSTILE_ORDINALS,
      ...HOSTILE_SORTS,
    ];
    let probes = 0;
    for (const sort of SORT_NAMES) {
      for (const field of ["s", "k", "i", "n", "t"]) {
        for (const [label, value] of EVERY_VALUE) {
          const res = await api(
            `/gallery?sort=${sort}&cursor=${encodeURIComponent(mint(valid(sort, { [field]: value })))}`,
          );
          const body = await res.text();
          const tag = `sort=${sort} ${field}=${label}`;
          probes += 1;
          expect(res.status, `${tag} → ${res.status} ${body}`).toBeLessThan(500);
          for (const leak of LEAKS) {
            expect(body, `${tag} leaked ${leak}`).not.toContain(leak);
          }
        }
      }
    }
    // 3 sorts × 5 fields × the whole corpus.
    expect(probes).toBe(SORT_NAMES.length * 5 * EVERY_VALUE.length);
    expect(probes).toBeGreaterThan(600);
  }, 300_000);

  it("E-G17: a NUL byte in `q` is a 400 — one query parameter used to be the cheapest 500 on the surface", async () => {
    // F3. No cursor, no session, one parameter: `GET /v1/gallery?q=%00` answered
    // `500 … 22021 invalid byte sequence for encoding "UTF8": 0x00` because
    // `GalleryListQuerySchema.q` is a bare `z.string().optional()` and `escapeLike` handles
    // only `\ % _`. U-GQ6/U-GQ7/E-G10 covered `%`, `_`, `\` and blank — never a control byte.
    for (const raw of ["\u0000", "a\u0000b", "a\u001Bb", "a\u007Fb"]) {
      const res = await api(`/gallery?q=${encodeURIComponent(raw)}`);
      const body = await res.text();
      expect(res.status, `q=${JSON.stringify(raw)} → ${res.status} ${body}`).toBe(400);
      expect(JSON.parse(body).error).toBe("invalid_query");
      expect(body).not.toContain("22021");
      expect(body).not.toContain("byte sequence");
    }

    // F9 — `q` was bounded only ACCIDENTALLY, by Node's 16 KB request-line limit (12 000
    // chars answered 200; 20 000 answered 431). A 12 KB `q` meant three ILIKE '%…%'
    // comparisons per row on a public, unauthenticated, unindexed, unrate-limited endpoint.
    const over = await api(`/gallery?q=${"a".repeat(12_000)}`);
    expect(over.status).toBe(400);
    expect((await over.json()).error).toBe("invalid_query");

    // …and the bound is a bound: 200 characters is still a legal search.
    const atBound = await api(`/gallery?q=${"a".repeat(200)}`);
    expect(atBound.status).toBe(200);
    // Tab / newline survive — they are whitespace, plausible in a paste, and Postgres carries
    // them fine, so only the non-whitespace controls are refused.
    const tabbed = await api(`/gallery?q=${encodeURIComponent("a\tb")}`);
    expect(tabbed.status).toBe(200);

    // N3, and the correction to this test's own claim. VT (U+000B) and FF (U+000C) are the two
    // control characters `String.prototype.trim()` treats as whitespace but the exempt set does
    // NOT include, so testing the class AFTER trimming deleted the evidence for them.
    // MEASURED at 5958b9f: `?q=%0B` and `?q=%0C` each answered **200 with 24 items — the whole
    // first page, byte-identical to a blank `q`** — a match-everything listing handed back in
    // answer to a hostile input, which is the exact outcome the reject-don't-repair rule exists
    // to prevent. `?q=a%0Bb` was already a 400 (trim cannot reach the middle of a string), which
    // is why the test that existed passed while the bug lived.
    const CTRL = (code: number) => String.fromCodePoint(code);
    for (const [label, raw] of [
      ["a lone VT", CTRL(0x0b)],
      ["a lone FF", CTRL(0x0c)],
      ["a leading VT", `${CTRL(0x0b)}psalm`],
      ["a trailing VT", `psalm${CTRL(0x0b)}`],
      ["a leading FF", `${CTRL(0x0c)}psalm`],
      ["a trailing FF", `psalm${CTRL(0x0c)}`],
      ["a VT behind trimmable space", `  ${CTRL(0x0b)}  `],
    ] as Array<[string, string]>) {
      const res = await api(`/gallery?q=${encodeURIComponent(raw)}`);
      const body = await res.text();
      expect(res.status, `${label} → ${res.status} ${body}`).toBe(400);
      expect(JSON.parse(body).error, label).toBe("invalid_query");
    }

    // The EXEMPT three are still whitespace and still mean "absent" — so the fix did not turn a
    // pasted tab or newline into a 400. `%09` answers exactly what a blank `q` answers.
    const blank = await api("/gallery");
    const blankIds = idsOf((await blank.json()).items);
    for (const exempt of [CTRL(0x09), CTRL(0x0a), CTRL(0x0d)]) {
      const res = await api(`/gallery?q=${encodeURIComponent(exempt)}`);
      expect(res.status, `U+${exempt.codePointAt(0)!.toString(16)}`).toBe(200);
      expect(idsOf((await res.json()).items)).toEqual(blankIds);
    }

  }, 120_000);

  it("E-G20: a hostile `:id` PATH SEGMENT is a 400 on every gallery route — and an ordinary unknown id is still a 404", async () => {
    // N2, the other half of the same class as E-G16. `GalleryIdParamSchema` is
    // `z.string().min(1)` in db-lib, so `GET /v1/gallery/%00` and
    // `GET /v1/gallery/%00/stream-url` reached Prisma and answered UNAUTHENTICATED 500s (one a
    // `DriverAdapterError` carrying `invalid byte sequence for encoding "UTF8": 0x00`, the
    // other a Prisma error whose raw message carried an absolute source path). Measured here
    // across EVERY route that takes an `:id`, authed ones included — the previous claim that
    // "the authed routes 401 first" is only true for a caller with no session, and a signed-in
    // caller reached exactly the same 500.
    const group = await seedGroup("hostileid", [{}]);
    const realId: string = group.items[0].id;
    const token = group.token;
    const CH = (...codes: number[]) => String.fromCodePoint(...codes);

    /** [label, path suffix, method, send a bearer?] — every `:id` route on the surface. */
    const routes: Array<[string, string, string, boolean]> = [
      ["GET /gallery/:id anonymous", "", "GET", false],
      ["GET /gallery/:id authed", "", "GET", true],
      ["GET /gallery/:id/stream-url", "/stream-url", "GET", false],
      ["POST /gallery/:id/upvote", "/upvote", "POST", true],
      ["DELETE /gallery/:id/upvote", "/upvote", "DELETE", true],
      ["DELETE /gallery/:id", "", "DELETE", true],
    ];

    /** Path segments that must be a 400. Both the percent-encoded form and, where a client
     *  could send it raw, the raw form. */
    const hostile: Array<[string, string]> = [
      ["%00", "%00"],
      ["%00 embedded", `a${encodeURIComponent(CH(0))}b`],
      ["%00 appended to a REAL id", `${realId}${encodeURIComponent(CH(0))}`],
      ["%0B vertical tab", encodeURIComponent(CH(0x0b))],
      ["%0C form feed", encodeURIComponent(CH(0x0c))],
      ["%1B escape", encodeURIComponent(CH(0x1b))],
      ["%7F delete", encodeURIComponent(CH(0x7f))],
    ];
    // `%09` is deliberately NOT in that list. Tab is one of the three EXEMPT control
    // characters, so an id of a bare tab is safe text, reaches Prisma and is an ordinary 404 —
    // measured. Asserting 400 for it would have pinned a rule the code does not have and does
    // not want: the exempt set is {tab, LF, CR} and it is exempt everywhere or nowhere.
    for (const exempt of [CH(0x09), CH(0x0a), CH(0x0d)]) {
      const res = await api(`/gallery/${encodeURIComponent(exempt)}`);
      expect(res.status, `exempt U+${exempt.codePointAt(0)!.toString(16)}`).toBe(404);
    }

    for (const [routeLabel, suffix, method, authed] of routes) {
      for (const [label, segment] of hostile) {
        const res = await api(`/gallery/${segment}${suffix}`, authed ? token : undefined, {
          method,
        });
        const body = await res.text();
        const tag = `${routeLabel} ${label}`;
        // A 400 and not a 404: "not a well-formed id" is a different fact from "no such item",
        // and the two are fixed by different client changes.
        expect(res.status, `${tag} → ${res.status} ${body}`).toBe(400);
        for (const leak of LEAKS) {
          expect(body, `${tag} leaked ${leak}`).not.toContain(leak);
        }
      }

      // UNIFORM DENIAL SURVIVES THE GATE, which is the thing that could most easily have been
      // broken by tightening this schema: an unknown id, a foreign-looking id and a real id
      // the caller does not own must all stay indistinguishable 404s. A cuid-shaped regex
      // would have turned every one of these into a 400 and coupled the route to the id
      // generator.
      // (Kept inside Fastify's `maxParamLength`, which is 100 by default — see the separate
      // over-long assertion below.)
      for (const unknown of ["no-such-item", "gal-1", "a-b_c.d~e", "0", "x".repeat(64)]) {
        const res = await api(`/gallery/${unknown}${suffix}`, authed ? token : undefined, {
          method,
        });
        expect(res.status, `${routeLabel} ${unknown} → ${res.status}`).toBe(404);
        expect((await res.json()).error).toBe("not_found");
      }
    }

    // ...and the RENDER `:id` on the publish route, which is the same class on the write path.
    const publishHostile = await api(
      `/renders/${encodeURIComponent(`render${CH(0)}`)}/gallery`,
      token,
      { method: "POST", body: publishBody() },
    );
    expect(publishHostile.status, await publishHostile.clone().text()).toBe(400);

    // AN OVER-LONG `:id` NEEDS NO GATE OF OURS, and this is why there is no length bound in the
    // params schema: MEASURED, a 200-character segment is a **414** and an 8 000-character one
    // likewise — the router/transport refuses it before any handler runs. (An id is compared
    // for EQUALITY against an indexed column, so even an accepted long id costs one index
    // probe; that is nothing like `q`, whose length bound exists because it drives three
    // unanchored `ILIKE '%…%'` scans per row.)
    for (const long of ["x".repeat(200), "x".repeat(8_000)]) {
      const res = await api(`/gallery/${long}`);
      expect(res.status, `${long.length}-char id → ${res.status}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${long.length}-char id → ${res.status}`).toBeLessThan(500);
    }

    // THE NEW 400 IS THE SURFACE'S EXISTING 400, not a second error contract. The params gate
    // is a Zod refinement, so its reply goes through the same `errorResponseSchema` the route
    // already declared — which means `{error, message}` and NOT Fastify's raw
    // `{statusCode, code, error, message}`. Asserted against the pre-existing querystring
    // rejection so the two cannot drift.
    const paramReject = await api(`/gallery/${encodeURIComponent(CH(0))}`);
    const queryReject = await api("/gallery?sort=hot");
    const paramBody = await paramReject.json();
    const queryBody = await queryReject.json();
    expect(Object.keys(paramBody).sort()).toEqual(Object.keys(queryBody).sort());
    expect(paramBody.error).toBe(queryBody.error);
    expect(paramBody.message).toContain("params/id");
    expect(paramBody.message).toContain("control character");

    // A malformed percent-escape and a non-UTF-8 byte sequence in the path must also not 5xx.
    // MEASURED: `%zz`, `%FF`, `%C0%80` and `%ED%A0%80` are all `400 FST_ERR_BAD_URL` from the
    // ROUTER, before any route or schema exists; `%2F` and `%25` decode to `/` and `%`, which
    // are ordinary safe text and therefore ordinary 404s.
    for (const segment of ["%zz", "%FF", "%C0%80", "%ED%A0%80", "%2F", "%25"]) {
      const res = await api(`/gallery/${segment}`);
      const body = await res.text();
      expect(res.status, `${segment} → ${res.status} ${body}`).toBeLessThan(500);
      for (const leak of LEAKS) {
        expect(body, `${segment} leaked ${leak}`).not.toContain(leak);
      }
    }
  }, 300_000);

  it("E-G21: a hostile PUBLISH BODY string is a 400 and writes nothing — including a reference that derives and THEN carries a NUL", async () => {
    // The write path's half of the class, and the one the audit did not report at all. `title`,
    // `description` and `translation` went straight into the INSERT with no text gate, so a NUL
    // in any of them was a 500 for an AUTHENTICATED caller. `scriptureReference` looked safe
    // only because `deriveScriptureBook` 422s on garbage — which stops being true the moment
    // the NUL is APPENDED to a reference that derives fine. Measured at 5958b9f: all four are
    // 500s, `scriptureReference: "Psalm 91:1<NUL>"` among them.
    const user = await seedUser("hostilebody");
    const project = await seedProject(user.userId, "hostilebody");
    const CH = (...codes: number[]) => String.fromCodePoint(...codes);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["title + NUL", { title: `He Who Dwells${CH(0)}` }],
      ["title NUL only", { title: CH(0) }],
      ["title + VT", { title: `He${CH(0x0b)}Dwells` }],
      ["title + DEL", { title: `He${CH(0x7f)}Dwells` }],
      ["description + NUL", { description: `nine scenes${CH(0)}` }],
      ["description unpaired surrogate", { description: CH(0xd800) }],
      // The deriver SUCCEEDS on this one, so at 5958b9f the INSERT was attempted.
      ["scriptureReference derives THEN NUL", { scriptureReference: `Psalm 91:1${CH(0)}` }],
      ["translation + NUL", { translation: `BSB${CH(0)}` }],
    ];

    for (const [label, over] of cases) {
      const renderId = await seedCompletedRender(user, project, `hb${cases.indexOf(over as any)}`);
      const res = await publish(user.token, renderId, over);
      const body = await res.text();
      expect(res.status, `${label} → ${res.status} ${body}`).toBe(400);
      for (const leak of LEAKS) {
        expect(body, `${label} leaked ${leak}`).not.toContain(leak);
      }
      // NOTHING was written: the render is still publishable afterwards.
      const rows = await prisma.galleryItem.count({ where: { renderJobId: renderId } });
      expect(rows, `${label} wrote a row`).toBe(0);
    }

    // ...and the gate is not over-tight: a title with real punctuation, an emoji, a newline in
    // the description and both LIKE metacharacters still publishes.
    const okRender = await seedCompletedRender(user, project, "hbok");
    const ok = await publish(user.token, okRender, {
      title: "Café 100% — “He Who Dwells” 🙏",
      description: "line one\nline two\tindented\r\nwith a % and an _",
      scriptureReference: "Psalm 91:1",
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const item = (await ok.json()).item;
    expect(item.title).toBe("Café 100% — “He Who Dwells” 🙏");
    // Round-tripped through Postgres UNCHANGED — which is the whole point of rejecting the
    // values that would not have.
    const read = await api(`/gallery/${item.id}`);
    expect((await read.json()).item.description).toBe(
      "line one\nline two\tindented\r\nwith a % and an _",
    );
  }, 300_000);

});

// ----------------------------------------------------------------------- search (D9)

describe("e2e: free-text search", () => {
  it("E-G10: q matches title, description and reference; `%` is a LITERAL; blank q behaves as absent", async () => {
    const titleToken = nonce("title");
    const descToken = nonce("desc");
    const refToken = nonce("ref");
    // The reference stays derivable — `deriveScriptureBook` takes the FIRST recognized
    // book, so a trailing token cannot break it.
    const reference = `Habakkuk 3:2 ${refToken}`;
    expect(deriveScriptureBook(reference)).toBe("HAB");

    const group = await seedGroup("search", [
      { over: { title: `Title hit ${titleToken}` } },
      { over: { description: `Description hit ${descToken}` } },
      { over: { scriptureReference: reference } },
    ]);
    const { groupNonce, items } = group;
    // seedGroup writes the group nonce into title AND description; the per-case `over`
    // replaces one of them, so re-derive which field each item still carries it in.
    const groupHits = await listItems(`?q=${groupNonce}`);
    expect(idsOf(groupHits.items).sort()).toEqual(idsOf(items).sort());

    const byTitle = await listItems(`?q=${titleToken}`);
    expect(idsOf(byTitle.items)).toEqual([items[0].id]);

    const byDescription = await listItems(`?q=${descToken}`);
    expect(idsOf(byDescription.items)).toEqual([items[1].id]);

    const byReference = await listItems(`?q=${refToken}`);
    expect(idsOf(byReference.items)).toEqual([items[2].id]);

    // THE ESCAPE TEST. Without `escapeLike`, `%` is a match-everything wildcard and `_`
    // matches any single character — a real, easily-missed bug.
    // SCOPED, not global. These two assertions used to be `toEqual([])` — i.e. "no row in the
    // whole database contains a literal % or _". That is an assumption about every OTHER
    // spec's fixtures, which this file's own header forbids for exactly this reason, and
    // E-G21 broke it the moment it published a title containing "100%" to prove the text gate
    // is not over-tight. What "% is a LITERAL" actually means is that `%` does not match
    // everything, so that is what is asserted: none of THIS group's items comes back.
    const percent = await listItems(`?q=${encodeURIComponent("%")}`);
    expect(idsOf(percent.items).filter((id) => idsOf(items).includes(id))).toEqual([]);
    const underscore = await listItems(`?q=${encodeURIComponent("_")}`);
    expect(idsOf(underscore.items).filter((id) => idsOf(items).includes(id))).toEqual([]);
    // ...and it is genuinely not a match-everything: a blank `q` DOES return this group.
    const blankQ = await listItems(`?q=${groupNonce}`);
    expect(idsOf(blankQ.items).length).toBeGreaterThan(0);
    const partial = await listItems(`?q=${encodeURIComponent(`${titleToken.slice(0, 6)}_`)}`);
    expect(partial.items).toEqual([]);

    // Blank q is treated as ABSENT, never as a `%%` predicate.
    const blank = await listItems(`?q=${encodeURIComponent("   ")}&sort=newest`);
    const absent = await listItems("?sort=newest");
    expect(idsOf(blank.items)).toEqual(idsOf(absent.items));
    expect(blank.items.length).toBeGreaterThan(0);

    // Case-insensitive (ILIKE), and a substring hit is enough.
    const upper = await listItems(`?q=${titleToken.toUpperCase()}`);
    expect(idsOf(upper.items)).toEqual([items[0].id]);
    const substring = await listItems(`?q=${titleToken.slice(2, 10)}`);
    expect(idsOf(substring.items)).toContain(items[0].id);
  }, 120_000);
});

// ------------------------------------------------------------ stream-url + thumbnails

describe("e2e: stream-url and thumbnails", () => {
  it("E-G11: stream-url is fetched with NO Authorization header and the returned URL plays the exact bytes", async () => {
    const user = await seedUser("stream");
    const project = await seedProject(user.userId, "stream");
    const renderId = await seedCompletedRender(user, project, "stream");
    const item = await publishOk(user.token, renderId, { title: `Stream ${nonce("s")}` });

    const res = await api(`/gallery/${item.id}/stream-url`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const played = await fetch(body.url);
    expect(played.status).toBe(200);
    const expected = outputBytes.get(renderId)!;
    expect(await played.text()).toBe(expected);
    expect(Number(played.headers.get("content-length"))).toBe(
      Buffer.byteLength(expected),
    );

    // An unknown item 404s uniformly (never leaks existence), even though this route has
    // no auth at all.
    expect((await api("/gallery/no-such-item/stream-url")).status).toBe(404);
  });

  it("E-G12: the signed URL points at the PUBLIC S3 endpoint (never minio:9000) and expires in ~120 s", async () => {
    const user = await seedUser("ttl");
    const project = await seedProject(user.userId, "ttl");
    const renderId = await seedCompletedRender(user, project, "ttl");
    const item = await publishOk(user.token, renderId, { title: `Ttl ${nonce("t")}` });

    const before = Date.now();
    const res = await api(`/gallery/${item.id}/stream-url`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const url = new URL(body.url);
    expect(url.host).toBe(new URL(S3_CFG.publicEndpoint).host);
    expect(url.host).not.toContain("minio:9000");
    expect(body.url).toContain("X-Amz-Signature");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(STREAM_TTL_SECONDS));

    const ttlMs = new Date(body.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan((STREAM_TTL_SECONDS - 10) * 1000);
    expect(ttlMs).toBeLessThan((STREAM_TTL_SECONDS + 10) * 1000);
  });

  it("E-G14: a listing DTO's thumbnailUrl is usable ANONYMOUSLY and returns the thumbnail bytes", async () => {
    const user = await seedUser("thumb");
    const project = await seedProject(user.userId, "thumb");
    const renderId = await seedCompletedRender(user, project, "thumb");
    const token = nonce("thumb");
    await publishOk(user.token, renderId, { title: `Thumb ${token}` });

    const { items } = await listItems(`?q=${token}`);
    expect(items).toHaveLength(1);
    const url = items[0].thumbnailUrl as string;
    expect(typeof url).toBe("string");
    expect(new URL(url).host).toBe(new URL(S3_CFG.publicEndpoint).host);

    // The auth-scoped GET /v1/files/presign-download could never serve an anonymous grid,
    // which is exactly why the listing signs each poster itself.
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(thumbBytes.get(renderId));
  });
});

// ------------------------------------------------------------------- visibility (D12)

describe("e2e: visibility", () => {
  it("E-G13: an unlisted item is absent from the listing under ALL THREE sorts, but readable and streamable by link", async () => {
    const user = await seedUser("unlisted");
    const project = await seedProject(user.userId, "unlisted");
    const token = nonce("unlisted");

    const publicRender = await seedCompletedRender(user, project, "unl-pub");
    const hiddenRender = await seedCompletedRender(user, project, "unl-hid");
    const shown = await publishOk(user.token, publicRender, {
      title: `Public ${token}`,
    });
    const hidden = await publishOk(user.token, hiddenRender, {
      title: `Unlisted ${token}`,
      visibility: "unlisted",
    });
    expect(hidden.visibility).toBe("unlisted");

    for (const sort of ["popular", "newest", "trending"]) {
      const { items } = await listItems(`?q=${token}&sort=${sort}`);
      expect(idsOf(items), sort).toEqual([shown.id]);
    }

    // The OWNER does not see it in the listing either: the listing is ONE public
    // projection, and making it viewer-dependent would make the cursor, the ranks and any
    // future caching viewer-dependent too.
    const asOwner = await listItems(`?q=${token}`, user.token);
    expect(idsOf(asOwner.items)).toEqual([shown.id]);

    // ...but "unlisted" means hidden from the LISTING, reachable by link.
    const direct = await api(`/gallery/${hidden.id}`);
    expect(direct.status).toBe(200);
    expect((await direct.json()).item.id).toBe(hidden.id);
    const stream = await api(`/gallery/${hidden.id}/stream-url`);
    expect(stream.status).toBe(200);
    expect((await fetch((await stream.json()).url)).status).toBe(200);

    // A row that does not exist is a uniform 404, never a distinguishable denial.
    expect((await api("/gallery/no-such-item")).status).toBe(404);
  }, 120_000);
});

// ------------------------------------------------------------- optional auth (D2)

describe("e2e: the optionalAuth degrade", () => {
  it("E-G18: a PRESENT-BUT-INVALID bearer reads the gallery as ANONYMOUS (200) and is still 401 on every authed route", async () => {
    // D2 is the ONE auth carve-out on this surface, and until now it was pinned only against a
    // FAKE auth service (U-OA4/U-GR2/U-GR6). An adversarial audit's mutation M5 — make
    // `optionalAuth` 401 on a present-but-invalid token — was caught by those three unit tests
    // and the gallery e2e stayed 25/25 GREEN, because nothing here ever sent a bad bearer to
    // the real app. That matters more than usual: the whole reason to degrade is that the BFF
    // forwards whatever session cookie is present, so this is the behaviour a user with a
    // stale cookie actually gets, and it was proven only against a stand-in.
    const user = await seedUser("degrade");
    const project = await seedProject(user.userId, "degrade");
    const renderId = await seedCompletedRender(user, project, "degrade");
    const token = nonce("degrade");
    const item = await publishOk(user.token, renderId, { title: `Degrade ${token}` });

    // A token with the right SHAPE that resolves to no session — i.e. exactly a stale cookie,
    // reaching the REAL AuthService and the REAL session table.
    const stale = "totally-invalid-token-that-is-not-in-the-session-table";

    // The two `optionalAuth` reads degrade to anonymous rather than erroring…
    const listed = await api(`/gallery?q=${token}`, stale);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const listBody = await listed.json();
    expect(idsOf(listBody.items)).toEqual([item.id]);
    // Anonymous means anonymous: no personalization is invented for the bad token.
    expect(listBody.items[0].viewerHasUpvoted).toBe(false);

    const one = await api(`/gallery/${item.id}`, stale);
    expect(one.status).toBe(200);
    expect((await one.json()).item.viewerHasUpvoted).toBe(false);

    // …and a malformed header (not even `Bearer <x>`) is the same 200, with no session lookup.
    const malformed = await fetch(`${baseUrl}/v1/gallery?q=${token}`, {
      headers: { authorization: "not-a-bearer-header" },
    });
    expect(malformed.status).toBe(200);

    // The no-auth route is unaffected either way.
    expect((await api(`/gallery/${item.id}/stream-url`, stale)).status).toBe(200);

    // But the SAME token is a hard 401 on every route that needs a session — which is the
    // other half of the contract, and what makes the degrade a carve-out rather than a hole.
    for (const [method, path] of [
      ["POST", `/gallery/${item.id}/upvote`],
      ["DELETE", `/gallery/${item.id}/upvote`],
      ["DELETE", `/gallery/${item.id}`],
      ["POST", `/renders/${renderId}/gallery`],
    ] as Array<[string, string]>) {
      const res = await api(path, stale, {
        method,
        ...(method === "POST" && path.endsWith("/gallery") ? { body: publishBody() } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((await res.json()).error, `${method} ${path}`).toBe("unauthorized");
    }
    // No vote was cast by any of that.
    const row = await prisma.galleryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.upvoteCount).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------- un-publish

describe("e2e: un-publish", () => {
  it("E-G15: DELETE by a non-owner 404s and the item survives; by the owner it 200s, leaves the listing, and frees the render", async () => {
    const owner = await seedUser("del-owner");
    const other = await seedUser("del-other");
    const project = await seedProject(owner.userId, "del");
    const renderId = await seedCompletedRender(owner, project, "del");
    const token = nonce("del");
    const item = await publishOk(owner.token, renderId, { title: `Delete me ${token}` });

    expect((await api(`/gallery/${item.id}`, undefined, { method: "DELETE" })).status).toBe(
      401,
    );
    const foreign = await api(`/gallery/${item.id}`, other.token, { method: "DELETE" });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error).toBe("not_found");
    expect(await prisma.galleryItem.count({ where: { id: item.id } })).toBe(1);

    const removed = await api(`/gallery/${item.id}`, owner.token, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });

    expect(idsOf((await listItems(`?q=${token}`)).items)).toEqual([]);
    expect((await api(`/gallery/${item.id}`)).status).toBe(404);
    expect((await api(`/gallery/${item.id}/stream-url`)).status).toBe(404);

    // The unique renderJobId slot is freed, so the render can be re-published. (The S3
    // objects are deliberately NOT deleted — that is the cleanup workflow's job.)
    const republished = await publishOk(owner.token, renderId, {
      title: `Republished ${token}`,
    });
    expect(republished.id).not.toBe(item.id);
    expect(republished.renderJobId).toBe(renderId);
    const stillThere = await fetch(
      (await (await api(`/gallery/${republished.id}/stream-url`)).json()).url,
    );
    expect(stillThere.status).toBe(200);
  }, 120_000);
});

// ==================================================================== row 40 specs

/** Shared by E-U2 → E-U6 and by E-U4 → E-U8. */
let voteFixture:
  | { itemId: string; users: SeededUser[]; groupNonce: string; itemIds: string[] }
  | undefined;
let concurrentFixture:
  | { itemIds: string[]; users: SeededUser[]; groupNonce: string }
  | undefined;

describe("e2e: upvotes", () => {
  it("E-U1: an ANONYMOUS upvote 401s on both verbs and the count is unchanged", async () => {
    const user = await seedUser("anon-vote");
    const project = await seedProject(user.userId, "anon-vote");
    const renderId = await seedCompletedRender(user, project, "anon-vote");
    const item = await publishOk(user.token, renderId, { title: `Anon ${nonce("av")}` });

    for (const method of ["POST", "DELETE"]) {
      const res = await api(`/gallery/${item.id}/upvote`, undefined, { method });
      expect(res.status, method).toBe(401);
      expect((await res.json()).error, method).toBe("unauthorized");
    }
    const row = await prisma.galleryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.upvoteCount).toBe(0);
    expect(await prisma.galleryUpvote.count({ where: { galleryItemId: item.id } })).toBe(0);
  });

  it("E-U2: one vote 200s, takes upvoteCount 0 → 1 and sets viewerHasUpvoted", async () => {
    const users = await seedUsers("vote", 3);
    const project = await seedProject(users[0].userId, "vote");
    const groupNonce = nonce("vote");
    const itemIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const renderId = await seedCompletedRender(users[0], project, `vote${i}`);
      const item = await publishOk(users[0].token, renderId, {
        title: `Votable ${i} ${groupNonce}`,
      });
      itemIds.push(item.id);
    }

    const res = await api(`/gallery/${itemIds[0]}/upvote`, users[1].token, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const item = (await res.json()).item;
    expect(item.upvoteCount).toBe(1);
    expect(item.viewerHasUpvoted).toBe(true);
    expect(await prisma.galleryUpvote.count({ where: { galleryItemId: itemIds[0] } })).toBe(
      1,
    );

    voteFixture = { itemId: itemIds[0], users, groupNonce, itemIds };
  }, 120_000);

  it("E-U3: five SEQUENTIAL duplicate votes are a no-op — 200 each, count stays 1, exactly one row", async () => {
    if (!voteFixture) throw new Error("E-U2 must run first");
    const { itemId, users } = voteFixture;

    for (let i = 0; i < 5; i += 1) {
      const res = await api(`/gallery/${itemId}/upvote`, users[1].token, {
        method: "POST",
      });
      // 200, not 409: re-voting is a no-op with no payload to lose.
      expect(res.status, `attempt ${i}`).toBe(200);
      expect((await res.json()).item.upvoteCount, `attempt ${i}`).toBe(1);
    }
    const row = await prisma.galleryItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.upvoteCount).toBe(1);
    expect(await prisma.galleryUpvote.count({ where: { galleryItemId: itemId } })).toBe(1);
  }, 120_000);

  it("E-U7: the listing reflects the VIEWER's own vote state, and the count is identical for everyone", async () => {
    if (!voteFixture) throw new Error("E-U2 must run first");
    const { itemId, users, groupNonce } = voteFixture;

    const asVoter = await listItems(`?q=${groupNonce}`, users[1].token);
    const asOther = await listItems(`?q=${groupNonce}`, users[2].token);
    const asAnon = await listItems(`?q=${groupNonce}`);

    const pick = (page: { items: any[] }) =>
      page.items.find((i) => i.id === itemId)!;
    expect(pick(asVoter).viewerHasUpvoted).toBe(true);
    expect(pick(asOther).viewerHasUpvoted).toBe(false);
    expect(pick(asAnon).viewerHasUpvoted).toBe(false);
    // upvoteCount is a global fact; only viewerHasUpvoted is personal.
    expect(pick(asVoter).upvoteCount).toBe(1);
    expect(pick(asOther).upvoteCount).toBe(1);
    expect(pick(asAnon).upvoteCount).toBe(1);

    // The single-item read personalizes the same way.
    const one = await api(`/gallery/${itemId}`, users[1].token);
    expect((await one.json()).item.viewerHasUpvoted).toBe(true);
    const anonOne = await api(`/gallery/${itemId}`);
    expect((await anonOne.json()).item.viewerHasUpvoted).toBe(false);
  }, 120_000);

  it("E-U6: unvoting returns the count to 0, and a SECOND unvote 200s with the count still 0 (never negative)", async () => {
    if (!voteFixture) throw new Error("E-U2 must run first");
    const { itemId, users } = voteFixture;

    const first = await api(`/gallery/${itemId}/upvote`, users[1].token, {
      method: "DELETE",
    });
    expect(first.status).toBe(200);
    expect((await first.json()).item.upvoteCount).toBe(0);

    const again = await api(`/gallery/${itemId}/upvote`, users[1].token, {
      method: "DELETE",
    });
    expect(again.status).toBe(200);
    const item = (await again.json()).item;
    expect(item.upvoteCount).toBe(0);
    expect(item.viewerHasUpvoted).toBe(false);

    const row = await prisma.galleryItem.findUniqueOrThrow({ where: { id: itemId } });
    // The `upvoteCount > 0` floor guard makes this unbreakable.
    expect(row.upvoteCount).toBe(0);
    expect(await prisma.galleryUpvote.count({ where: { galleryItemId: itemId } })).toBe(0);
  }, 120_000);

  it("E-U4: 8 CONCURRENT votes from 8 distinct users produce EXACTLY 8 — run twice", async () => {
    // THE LOST-UPDATE PROOF. Prisma compiles `{ increment: 1 }` to
    // `SET "upvoteCount" = "upvoteCount" + 1`, which Postgres re-reads under the row
    // lock. A findUnique + update({ upvoteCount: n + 1 }) would pass a sequential test and
    // silently lose updates here under READ COMMITTED.
    for (let run = 0; run < 2; run += 1) {
      const users = await seedUsers(`conc${run}`, 8);
      const project = await seedProject(users[0].userId, `conc${run}`);
      const groupNonce = nonce(`conc${run}`);
      const itemIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const renderId = await seedCompletedRender(users[0], project, `conc${run}${i}`);
        const item = await publishOk(users[0].token, renderId, {
          title: `Concurrent ${i} ${groupNonce}`,
        });
        itemIds.push(item.id);
      }

      const responses = await Promise.all(
        users.map((u) =>
          api(`/gallery/${itemIds[0]}/upvote`, u.token, { method: "POST" }),
        ),
      );
      for (const res of responses) expect(res.status).toBe(200);

      const row = await prisma.galleryItem.findUniqueOrThrow({
        where: { id: itemIds[0] },
      });
      expect(row.upvoteCount, `run ${run}`).toBe(8);
      expect(
        await prisma.galleryUpvote.count({ where: { galleryItemId: itemIds[0] } }),
        `run ${run}`,
      ).toBe(8);

      concurrentFixture = { itemIds, users, groupNonce };
    }
  }, 180_000);

  it("E-U5: 8 PARALLEL duplicate votes from the SAME user give count 1, one row, and NO 5xx", async () => {
    // WHAT THIS EARNS, stated honestly — an earlier version of this comment called itself
    // "THE P2002-IN-A-TRANSACTION PROOF" and an adversarial audit was right to refute that.
    //
    // Measured, not assumed: this case (with E-U3) goes RED for the shape that swallows a
    // P2002 and then increments UNCONDITIONALLY — the transaction is already aborted, so the
    // increment raises 25P02. It stays GREEN for a `try { create } catch (P2002) { skip the
    // increment }` and for check-then-insert, because both of those are genuinely correct
    // too. So what this proves is the REAL invariant — a same-user burst commits, ends at
    // exactly one vote and one row, and never 5xxes — and not the stronger claim that only
    // `createMany({ skipDuplicates })` can do it.
    //
    // The 25P02 hazard itself is pinned by U-UV11, a unit test driving `upvote` against a fake
    // that models Postgres's abort semantics; the choice of `createMany` over a correct
    // try/catch is pinned by the shape assertions U-UV2/U-UV3/U-UV7, and its reasons are about
    // the code (the abort becomes structurally unreachable; one round trip, not two) rather
    // than about behaviour. See the `upvote` doc-comment.
    const users = await seedUsers("dupconc", 1);
    const project = await seedProject(users[0].userId, "dupconc");
    const renderId = await seedCompletedRender(users[0], project, "dupconc");
    const item = await publishOk(users[0].token, renderId, {
      title: `Dup burst ${nonce("dc")}`,
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        api(`/gallery/${item.id}/upvote`, users[0].token, { method: "POST" }),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBeLessThan(500);
      expect(res.status).toBe(200);
    }

    const row = await prisma.galleryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.upvoteCount).toBe(1);
    expect(await prisma.galleryUpvote.count({ where: { galleryItemId: item.id } })).toBe(1);
  }, 120_000);

  it("E-U8: real votes move the popular ORDER — 8 > 3 > 0 — and a searched listing still carries no rank", async () => {
    if (!concurrentFixture) throw new Error("E-U4 must run first");
    const { itemIds, users, groupNonce } = concurrentFixture;

    // Give the second item 3 votes so the popular ordering is 8 > 3 > 0.
    for (const u of users.slice(0, 3)) {
      const res = await api(`/gallery/${itemIds[1]}/upvote`, u.token, { method: "POST" });
      expect(res.status).toBe(200);
    }

    const { items } = await listItems(`?q=${groupNonce}&sort=popular`);
    expect(idsOf(items)).toEqual([itemIds[0], itemIds[1], itemIds[2]]);
    expect(items.map((i) => i.upvoteCount)).toEqual([8, 3, 0]);
    // The ORDER is what real votes move; the BADGE is a claim about the whole gallery and
    // this listing is `q`-scoped, so there is none. (E-G6b is where a rank is asserted.)
    expect(items.map((i) => i.rank)).toEqual([null, null, null]);
  }, 120_000);

  it("E-U9: deleting an item cascades its upvote rows", async () => {
    if (!concurrentFixture) throw new Error("E-U4 must run first");
    const { itemIds, users } = concurrentFixture;
    const target = itemIds[0];

    expect(
      await prisma.galleryUpvote.count({ where: { galleryItemId: target } }),
    ).toBeGreaterThan(0);

    const removed = await api(`/gallery/${target}`, users[0].token, { method: "DELETE" });
    expect(removed.status).toBe(200);

    // The FK is onDelete: Cascade, so no orphan votes survive.
    expect(await prisma.galleryUpvote.count({ where: { galleryItemId: target } })).toBe(0);
    expect(await prisma.galleryItem.count({ where: { id: target } })).toBe(0);

    // Voting on a now-missing item is a uniform 404.
    const gone = await api(`/gallery/${target}/upvote`, users[0].token, {
      method: "POST",
    });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe("not_found");
  }, 120_000);
});
