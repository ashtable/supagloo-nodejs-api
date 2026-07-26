import { describe, it, expect } from "vitest";
import {
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  deriveScriptureBook,
  type PrismaClient,
} from "@supagloo/database-lib";
import { GalleryService } from "./gallery-service";
import { GALLERY_PAGE_SIZE, encodeCursor } from "./gallery-query";
import {
  GalleryItemAlreadyPublishedError,
  GalleryItemNotFoundError,
  InvalidGalleryCursorError,
  RenderNotPublishableError,
  ScriptureBookUnderivableError,
} from "./errors";

// Unit tests for GalleryService (Tasks #39 + #40, plan D7-D13). A FAKE Prisma + a
// recorder presign seam + a fixed clock let every branch be asserted DB-free:
//
//   - publish: owner-scoped render resolve (404), the four not-publishable gates (409),
//     server-derived durationSeconds, RECOMPUTED asset keys, derived scriptureBook (422
//     with ZERO writes), and the unique-violation → already_published mapping (409);
//   - listing: visibility=public in the SQL, the id-order re-sort, the ONE batched
//     viewer-vote query (the N+1 guard), zero vote queries for an anonymous viewer,
//     popular-only ranks continuous across pages, and the fetch-pageSize+1 exhaustion
//     rule that makes `nextCursor === null` mean GENUINELY exhausted;
//   - stream-url + thumbnails: the injected presign seam, the recomputed output key, and
//     the 120 s TTL;
//   - upvote/unvote (row 40): the transaction SHAPE, plus one behavioural pin. A P2002 raised
//     INSIDE a Postgres transaction marks it aborted (25P02) and Prisma issues no SAVEPOINT,
//     so `try { create } catch (P2002) {}` followed by ANY further statement is broken here.
//     U-UV2/U-UV3/U-UV7 pin `createMany({ skipDuplicates })` / `deleteMany` — never an
//     exception — as a SHAPE; U-UV11 pins the hazard behaviourally, against a fake that models
//     the abort. `{ increment: 1 }` rather than a read-then-write is what makes N concurrent
//     votes produce exactly N.
//
// Prisma ops, the transaction boundary and the presign seam all record onto ONE shared
// `calls` timeline (the lesson from the renders suite), so orderings are assertable as
// real relative positions via `at()` — which THROWS on a missing op, because
// `findIndex` returning -1 makes an ordering assertion about an op that never ran pass.
//
// Transactional writes record with a `tx:` prefix, so "both writes land on the SAME
// transaction client" is a structural assertion rather than a hope.

type Call = { op: string; args: any };

const NOW = new Date("2026-07-26T12:00:00.000Z");
const STREAM_TTL = 120;

interface FakeConfig {
  /** renderJob.findFirst result (publish's owner-scoped resolve). */
  render?: unknown;
  /** galleryItem.findFirst result (first call). */
  item?: unknown;
  /** galleryItem.findFirst result from the SECOND call onward (post-transaction re-read). */
  reReadItem?: unknown;
  /** galleryItem.findMany result (the listing's typed row fetch). */
  items?: unknown[];
  /** $queryRaw result: the ordered ids + sort keys. */
  rawRows?: Array<{ id: string; sortKey: unknown }>;
  /** galleryUpvote.findMany result (the viewer's votes on the page). */
  votes?: Array<{ galleryItemId: string }>;
  /** galleryItem.deleteMany count. */
  deletedCount?: number;
  /** galleryUpvote.createMany count (1 = a first vote, 0 = a duplicate). */
  createManyCount?: number;
  /** galleryUpvote.deleteMany count (1 = had voted, 0 = had not). */
  deleteVoteCount?: number;
  /** galleryItem.create throws this instead of returning. */
  createError?: unknown;
}

function makeFake(config: FakeConfig) {
  const calls: Call[] = [];
  let itemFindFirstCount = 0;

  const rec =
    (op: string, value: unknown) =>
    (args: any) => {
      calls.push({ op, args });
      return Promise.resolve(value);
    };

  // The TRANSACTION client. Every write the upvote/unvote paths make must land here, so
  // it records under a `tx:` prefix and is a DIFFERENT object from the root client.
  const tx = {
    galleryUpvote: {
      createMany: (args: any) => {
        calls.push({ op: "tx:galleryUpvote.createMany", args });
        return Promise.resolve({ count: config.createManyCount ?? 1 });
      },
      deleteMany: (args: any) => {
        calls.push({ op: "tx:galleryUpvote.deleteMany", args });
        return Promise.resolve({ count: config.deleteVoteCount ?? 1 });
      },
      // Present ONLY so U-UV7 can prove it is never reached. A `create` here would raise
      // P2002 on a duplicate vote and poison the transaction.
      create: (args: any) => {
        calls.push({ op: "tx:galleryUpvote.create", args });
        return Promise.resolve({ id: "vote-1", ...args.data });
      },
    },
    galleryItem: {
      update: (args: any) => {
        calls.push({ op: "tx:galleryItem.update", args });
        return Promise.resolve({});
      },
      updateMany: (args: any) => {
        calls.push({ op: "tx:galleryItem.updateMany", args });
        return Promise.resolve({ count: 1 });
      },
    },
  };

  const prisma = {
    renderJob: {
      findFirst: rec("renderJob.findFirst", config.render ?? null),
    },
    galleryItem: {
      findFirst: (args: any) => {
        calls.push({ op: "galleryItem.findFirst", args });
        itemFindFirstCount += 1;
        if (itemFindFirstCount >= 2 && config.reReadItem !== undefined) {
          return Promise.resolve(config.reReadItem);
        }
        return Promise.resolve(config.item ?? null);
      },
      findMany: rec("galleryItem.findMany", config.items ?? []),
      create: (args: any) => {
        calls.push({ op: "galleryItem.create", args });
        if (config.createError !== undefined) {
          return Promise.reject(config.createError);
        }
        // Model what Prisma actually returns: the DB DEFAULTS (a fresh item has
        // upvoteCount 0, not the fixture's 7) plus the supplied data plus the `owner`
        // relation the service asks for via `include`. Merging the fixture row here
        // instead would have hidden a service that echoed a stale count.
        return Promise.resolve({
          id: "gal-created",
          upvoteCount: 0,
          viewCount: 0,
          publishedAt: NOW,
          owner: { displayName: "Mary K", avatarInitials: "MK" },
          ...args.data,
        });
      },
      deleteMany: (args: any) => {
        calls.push({ op: "galleryItem.deleteMany", args });
        return Promise.resolve({ count: config.deletedCount ?? 1 });
      },
      // Root-client counterparts, present so "the write landed on the ROOT client, not
      // the transaction" is observable rather than invisible.
      update: (args: any) => {
        calls.push({ op: "galleryItem.update", args });
        return Promise.resolve({});
      },
      updateMany: (args: any) => {
        calls.push({ op: "galleryItem.updateMany", args });
        return Promise.resolve({ count: 1 });
      },
    },
    galleryUpvote: {
      findMany: rec("galleryUpvote.findMany", config.votes ?? []),
      createMany: (args: any) => {
        calls.push({ op: "galleryUpvote.createMany", args });
        return Promise.resolve({ count: config.createManyCount ?? 1 });
      },
      deleteMany: (args: any) => {
        calls.push({ op: "galleryUpvote.deleteMany", args });
        return Promise.resolve({ count: config.deleteVoteCount ?? 1 });
      },
      create: (args: any) => {
        calls.push({ op: "galleryUpvote.create", args });
        return Promise.resolve({});
      },
    },
    $queryRaw: (sql: any) => {
      calls.push({ op: "$queryRaw", args: { sql } });
      return Promise.resolve(config.rawRows ?? []);
    },
    $transaction: (fn: any) => {
      calls.push({ op: "$transaction", args: {} });
      return Promise.resolve(fn(tx));
    },
  };

  return { prisma: prisma as unknown as PrismaClient, calls };
}

const has = (calls: Call[], op: string) => calls.some((c) => c.op === op);
const count = (calls: Call[], op: string) =>
  calls.filter((c) => c.op === op).length;
const find = (calls: Call[], op: string) => calls.find((c) => c.op === op)!;

/**
 * Position of `op` on the SHARED timeline. THROWS when the op never happened: an
 * ordering claim about an op that did not run is a bug in the TEST, and
 * `expect(-1).toBeLessThan(0)` would report success.
 */
function at(calls: Call[], op: string): number {
  const i = calls.findIndex((c) => c.op === op);
  if (i === -1) {
    throw new Error(
      `expected op ${op} on the call timeline; saw: ${calls.map((c) => c.op).join(" → ") || "(nothing)"}`,
    );
  }
  return i;
}

function makePresignRecorder(calls: Call[], opts: { fail?: boolean } = {}) {
  const presigned: { key: string; ttl: number }[] = [];
  return {
    presignPublic: async (key: string, ttl: number) => {
      calls.push({ op: "s3.presignPublic", args: { key, ttl } });
      presigned.push({ key, ttl });
      if (opts.fail) throw new Error("presign exploded");
      return {
        url: `https://s3.test/${key}?sig=1`,
        expiresAt: new Date(NOW.getTime() + ttl * 1000),
      };
    },
    presigned,
  };
}

function makeService(
  fake: { prisma: PrismaClient; calls: Call[] },
  opts: {
    pageSize?: number;
    presignFails?: boolean;
    streamUrlTtlSeconds?: number;
  } = {},
) {
  const pre = makePresignRecorder(fake.calls, { fail: opts.presignFails });
  const service = new GalleryService({
    prisma: fake.prisma,
    presignPublic: pre.presignPublic,
    now: () => NOW,
    pageSize: opts.pageSize,
    streamUrlTtlSeconds: opts.streamUrlTtlSeconds,
  });
  return { service, presigned: pre.presigned };
}

// ------------------------------------------------------------------- fixtures

const RENDER_ID = "render-1";
const USER_ID = "user-1";

/** A `completed`, publishable RenderJob row. The stored asset keys are deliberately
 *  WRONG values so U-GV4 can prove the service recomputes them. */
function renderRow(over: Record<string, unknown> = {}) {
  return {
    id: RENDER_ID,
    projectId: "proj-1",
    versionId: "ver-1",
    userId: USER_ID,
    status: "completed",
    framesDone: 900,
    framesTotal: 900,
    width: 1080,
    height: 1920,
    fps: 30,
    aspectRatio: "9:16",
    codec: "h264",
    outputAssetKey: "renders/DELIBERATELY-WRONG/output.mp4",
    thumbnailAssetKey: "renders/DELIBERATELY-WRONG/thumb.jpg",
    runInBackground: false,
    error: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    ...over,
  };
}

const PUBLISHED_AT = new Date("2026-07-25T09:00:00.000Z");

/** A persisted GalleryItem row with its `owner` relation included, as the service reads
 *  it (the DTO needs `owner.displayName` / `owner.avatarInitials`). */
function itemRow(over: Record<string, unknown> = {}) {
  return {
    id: "gal-1",
    renderJobId: RENDER_ID,
    projectId: "proj-1",
    ownerId: USER_ID,
    title: "He Who Dwells",
    description: "Psalm 91 in nine scenes.",
    scriptureReference: "Psalm 91:1",
    translation: "BSB",
    scriptureBook: "PSA",
    durationSeconds: 30,
    videoAssetKey: buildRenderOutputKey(RENDER_ID),
    thumbnailAssetKey: buildRenderThumbnailKey(RENDER_ID),
    visibility: "public",
    publishedAt: PUBLISHED_AT,
    upvoteCount: 7,
    viewCount: 0,
    owner: { displayName: "Mary K", avatarInitials: "MK" },
    ...over,
  };
}

const PUBLISH_REQ = {
  title: "He Who Dwells",
  description: "Psalm 91 in nine scenes.",
  scriptureReference: "Psalm 91:1",
  translation: "BSB",
  visibility: "public" as const,
};

// ================================================================== publish (D7/D8)

describe("GalleryService.publish — preconditions and status codes", () => {
  it("U-GV1: resolves the render OWNER-SCOPED ({id, userId}); an unknown or foreign render 404s before any write", async () => {
    const fake = makeFake({ render: null });
    const { service } = makeService(fake);

    await expect(
      service.publish(USER_ID, RENDER_ID, PUBLISH_REQ),
    ).rejects.toBeInstanceOf(GalleryItemNotFoundError);

    expect(find(fake.calls, "renderJob.findFirst").args.where).toMatchObject({
      id: RENDER_ID,
      userId: USER_ID,
    });
    expect(has(fake.calls, "galleryItem.create")).toBe(false);
  });

  it("U-GV2: a render that is not publishable 409s — four distinct causes, none of which writes", async () => {
    const causes: Array<[string, Record<string, unknown>]> = [
      ["not completed", { status: "encoding" }],
      ["no outputAssetKey", { outputAssetKey: null }],
      ["no thumbnailAssetKey", { thumbnailAssetKey: null }],
      // framesTotal 0 means the render never reached bundleComposition, i.e. it is not
      // really complete — and it would make durationSeconds a lie.
      ["framesTotal 0", { framesTotal: 0 }],
    ];

    for (const [label, over] of causes) {
      const fake = makeFake({ render: renderRow(over) });
      const { service } = makeService(fake);
      await expect(
        service.publish(USER_ID, RENDER_ID, PUBLISH_REQ),
        label,
      ).rejects.toBeInstanceOf(RenderNotPublishableError);
      expect(has(fake.calls, "galleryItem.create"), label).toBe(false);
    }
  });

  it("U-GV3: durationSeconds is SERVER-derived as max(1, round(framesTotal / fps))", async () => {
    const table: Array<[number, number, number]> = [
      [900, 30, 30],
      [1, 30, 1], // rounds to 0 → floored to 1, never a 0-second badge
      [14, 30, 1], // 0.467 → 0 → 1
      [899, 30, 30], // 29.967 → 30
      [45, 30, 2], // 1.5 → 2
      [30, 30, 1],
      [3600, 24, 150],
      [1801, 60, 30], // 30.017 → 30
    ];

    for (const [framesTotal, fps, expected] of table) {
      const fake = makeFake({
        render: renderRow({ framesTotal, fps }),
        item: itemRow(),
      });
      const { service } = makeService(fake);
      const dto = await service.publish(USER_ID, RENDER_ID, PUBLISH_REQ);

      const label = `${framesTotal}/${fps}`;
      expect(
        find(fake.calls, "galleryItem.create").args.data.durationSeconds,
        label,
      ).toBe(expected);
      expect(dto.durationSeconds, label).toBe(expected);
    }
  });

  it("U-GV4: both asset keys are RECOMPUTED from the shared builders, never read from the row", async () => {
    const fake = makeFake({ render: renderRow(), item: itemRow() });
    const { service } = makeService(fake);
    await service.publish(USER_ID, RENDER_ID, PUBLISH_REQ);

    const data = find(fake.calls, "galleryItem.create").args.data;
    expect(data.videoAssetKey).toBe(buildRenderOutputKey(RENDER_ID));
    expect(data.thumbnailAssetKey).toBe(buildRenderThumbnailKey(RENDER_ID));
    // The row's stored strings were deliberately wrong; a service that trusted them
    // would persist a key `parseS3Key` cannot resolve.
    expect(data.videoAssetKey).not.toContain("DELIBERATELY-WRONG");
    expect(data.thumbnailAssetKey).not.toContain("DELIBERATELY-WRONG");
  });

  it("U-GV5: scriptureBook is DERIVED and persisted; an underivable reference 422s with ZERO writes", async () => {
    const fake = makeFake({ render: renderRow(), item: itemRow() });
    const { service } = makeService(fake);
    await service.publish(USER_ID, RENDER_ID, {
      ...PUBLISH_REQ,
      scriptureReference: "1 Corinthians 13:4",
    });
    const data = find(fake.calls, "galleryItem.create").args.data;
    expect(data.scriptureBook).toBe("1CO");
    expect(data.scriptureBook).toBe(deriveScriptureBook("1 Corinthians 13:4"));
    // The reference itself is stored VERBATIM — only the derived code is coarsened.
    expect(data.scriptureReference).toBe("1 Corinthians 13:4");

    for (const reference of ["a poem", "Book of Mormon 1:1", "Theodore"]) {
      expect(deriveScriptureBook(reference), reference).toBeNull();
      const bad = makeFake({ render: renderRow(), item: itemRow() });
      const svc = makeService(bad);
      await expect(
        svc.service.publish(USER_ID, RENDER_ID, {
          ...PUBLISH_REQ,
          scriptureReference: reference,
        }),
        reference,
      ).rejects.toBeInstanceOf(ScriptureBookUnderivableError);
      // The column is NOT NULL and the derivation is a lookup Zod cannot express, so
      // this is a service-level 422 — and it must reject BEFORE the insert.
      expect(has(bad.calls, "galleryItem.create"), reference).toBe(false);
    }
  });

  it("U-GV6: a unique violation on renderJobId (P2002) becomes already_published (409); any other error propagates", async () => {
    const dup = makeFake({
      render: renderRow(),
      createError: { code: "P2002", name: "PrismaClientKnownRequestError" },
    });
    await expect(
      makeService(dup).service.publish(USER_ID, RENDER_ID, PUBLISH_REQ),
    ).rejects.toBeInstanceOf(GalleryItemAlreadyPublishedError);

    // A second publish carries a DIFFERENT title/description/visibility, so returning an
    // idempotent 200 would look like the edit took. 409 is the honest answer.

    // The guard must be NARROW: an unrelated failure must not be reported as
    // already_published.
    const boom = new Error("connection reset");
    const other = makeFake({ render: renderRow(), createError: boom });
    await expect(
      makeService(other).service.publish(USER_ID, RENDER_ID, PUBLISH_REQ),
    ).rejects.toBe(boom);
  });

  it("U-GV6b: the published DTO is the public card shape — no ownerId, no videoAssetKey, rank null, not upvoted", async () => {
    const fake = makeFake({ render: renderRow(), item: itemRow() });
    const { service, presigned } = makeService(fake);

    const dto = await service.publish(USER_ID, RENDER_ID, {
      ...PUBLISH_REQ,
      visibility: "unlisted",
    });

    expect(dto).toMatchObject({
      renderJobId: RENDER_ID,
      title: PUBLISH_REQ.title,
      description: PUBLISH_REQ.description,
      scriptureReference: PUBLISH_REQ.scriptureReference,
      translation: PUBLISH_REQ.translation,
      visibility: "unlisted",
      upvoteCount: 0,
      rank: null,
      viewerHasUpvoted: false,
      owner: { displayName: "Mary K", avatarInitials: "MK" },
    });
    expect((dto as Record<string, unknown>).ownerId).toBeUndefined();
    expect((dto as Record<string, unknown>).videoAssetKey).toBeUndefined();
    expect((dto as Record<string, unknown>).viewCount).toBeUndefined();
    expect(typeof dto.publishedAt).toBe("string");
    // The card needs a poster immediately, and it is signed with the same short TTL as
    // the stream URL.
    expect(dto.thumbnailUrl).toContain(buildRenderThumbnailKey(RENDER_ID));
    expect(presigned).toEqual([
      { key: buildRenderThumbnailKey(RENDER_ID), ttl: STREAM_TTL },
    ]);
    // A fresh publish has no votes and no rank, and must not be counted as upvoted.
    expect(has(fake.calls, "galleryUpvote.findMany")).toBe(false);
  });
});

// ============================================================ listing (D4/D5/D11/D12)

describe("GalleryService.listGallery", () => {
  const threeRaw = [
    { id: "a", sortKey: 9 },
    { id: "b", sortKey: 5 },
    { id: "c", sortKey: 1 },
  ];
  const threeRows = [
    itemRow({ id: "a", upvoteCount: 9 }),
    itemRow({ id: "b", upvoteCount: 5 }),
    itemRow({ id: "c", upvoteCount: 1 }),
  ];

  it("U-GV7: the listing SQL is hard-scoped to visibility=public; getItem is NOT (unlisted is reachable by link)", async () => {
    const list = makeFake({ rawRows: threeRaw, items: threeRows });
    await makeService(list).service.listGallery(null, { sort: "popular" });
    const sql = find(list.calls, "$queryRaw").args.sql;
    expect(sql.strings.join(" ? ")).toContain("'public'");

    const one = makeFake({ item: itemRow({ visibility: "unlisted" }) });
    const dto = await makeService(one).service.getItem(null, "gal-1");
    expect(dto.visibility).toBe("unlisted");
    const where = find(one.calls, "galleryItem.findFirst").args.where;
    expect(where).toMatchObject({ id: "gal-1" });
    expect(Object.keys(where)).not.toContain("visibility");
  });

  it("U-GV7b: items come back in the SQL's ORDER, not the order Prisma returned them in", async () => {
    // Prisma's `findMany({ id: { in: [...] } })` gives NO ordering guarantee, so the
    // service must re-order to the id list the raw query produced. The fake returns them
    // shuffled to prove it does.
    const fake = makeFake({
      rawRows: threeRaw,
      items: [threeRows[2], threeRows[0], threeRows[1]],
    });
    const { items } = await makeService(fake).service.listGallery(null, {
      sort: "popular",
    });
    expect(items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(find(fake.calls, "galleryItem.findMany").args.where).toMatchObject({
      id: { in: ["a", "b", "c"] },
    });
  });

  it("U-GV8: the viewer's votes are resolved with ONE batched query for the whole page (the N+1 guard)", async () => {
    const fake = makeFake({
      rawRows: threeRaw,
      items: threeRows,
      votes: [{ galleryItemId: "b" }],
    });
    const { items } = await makeService(fake).service.listGallery("viewer-9", {
      sort: "popular",
    });

    expect(count(fake.calls, "galleryUpvote.findMany")).toBe(1);
    expect(find(fake.calls, "galleryUpvote.findMany").args.where).toMatchObject({
      userId: "viewer-9",
      galleryItemId: { in: ["a", "b", "c"] },
    });
    expect(items.map((i) => i.viewerHasUpvoted)).toEqual([false, true, false]);
  });

  it("U-GV9: an ANONYMOUS viewer triggers NO upvote query at all, and every item reads not-upvoted", async () => {
    const fake = makeFake({
      rawRows: threeRaw,
      items: threeRows,
      votes: [{ galleryItemId: "b" }], // would flip one if it were consulted
    });
    const { items } = await makeService(fake).service.listGallery(null, {
      sort: "popular",
    });
    expect(has(fake.calls, "galleryUpvote.findMany")).toBe(false);
    expect(items.map((i) => i.viewerHasUpvoted)).toEqual([false, false, false]);
  });

  it("U-GV10: rank is non-null ONLY for sort=popular, and is CONTINUOUS across pages", async () => {
    for (const sort of ["newest", "trending"] as const) {
      const fake = makeFake({ rawRows: threeRaw, items: threeRows });
      const { items } = await makeService(fake).service.listGallery(null, { sort });
      expect(items.map((i) => i.rank), sort).toEqual([null, null, null]);
    }

    const page1 = makeFake({ rawRows: threeRaw, items: threeRows });
    const first = await makeService(page1).service.listGallery(null, {
      sort: "popular",
    });
    expect(first.items.map((i) => i.rank)).toEqual([1, 2, 3]);

    // Page 2 of a 24-item page size starts at 25 — the cursor's `n` supplies the
    // starting ordinal. A client computing `index + 1` would badge the 25th item "#1".
    const page2 = makeFake({ rawRows: threeRaw, items: threeRows });
    const second = await makeService(page2).service.listGallery(null, {
      sort: "popular",
      cursor: encodeCursor({ s: "popular", k: 12, i: "prev-last", n: 24 }),
    });
    expect(second.items.map((i) => i.rank)).toEqual([25, 26, 27]);
  });

  it("U-GV10b: a row that VANISHES between the two queries leaves a rank GAP, not a shift — the ordinal is the SQL's, not the survivors'", async () => {
    // The listing is TWO queries: the raw keyset query produces the ordered ids, and a typed
    // `findMany` fetches the rows. A concurrent `DELETE /v1/gallery/:id` landing between them
    // makes the second return FEWER rows than the first, and the service already filters the
    // missing ids out.
    //
    // What it did NOT do was keep the ordinals honest. `rank` was indexed off the SURVIVORS
    // (`ordered`), while the next cursor's `n` advanced by the SQL page's length — so losing
    // row 2 of 3 badged the third item "#2" and then started page two at #4. Both a lie and a
    // gap, from one deletion.
    //
    // `rank` IS the position in the global ordering, so it must be derived from the position
    // the SQL gave the row. A vanished row then leaves a truthful HOLE (1, 3) instead of
    // renumbering the ones that survived, and `n` stays in the same coordinate system.
    const fourRaw = [
      { id: "a", sortKey: 9 },
      { id: "b", sortKey: 5 },
      { id: "c", sortKey: 1 },
      { id: "d", sortKey: 0 }, // the pageSize+1 exhaustion probe
    ];
    const fake = makeFake({
      rawRows: fourRaw,
      // "b" was deleted after the raw query and before the typed read.
      items: [itemRow({ id: "a", upvoteCount: 9 }), itemRow({ id: "c", upvoteCount: 1 })],
    });
    const page = await makeService(fake, { pageSize: 3 }).service.listGallery(null, {
      sort: "popular",
    });

    expect(page.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(page.items.map((i) => i.rank)).toEqual([1, 3]);
    // A SHORT page with a non-null nextCursor is the honest answer: there really is more, and
    // the cursor's ordinal counts positions in the ordering, not rows that survived.
    expect(page.nextCursor).not.toBeNull();
    expect(
      JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8")),
    ).toEqual({ s: "popular", k: 1, i: "c", n: 3 });
  });

  it("U-GV10c: a SEARCH-FILTERED listing carries NO rank — a position among hits is not a global ordinal", async () => {
    // `rank` is documented — on the DTO, in the service and in the UI — as the item's
    // position in the GLOBAL popular ordering, and the grid badges 1/2/3 with a trophy on
    // that promise. But the listing is ONE statement: the `q` ILIKE predicate sits in the
    // SAME `WHERE` as the `ORDER BY` and the `LIMIT`, so `startOrdinal + index + 1` counts
    // positions AMONG THE HITS. Typing anything into the gallery search box therefore
    // badged the top hit "#1" — an item that may be #400 globally, or have two upvotes.
    //
    // WHY THIS CASE DID NOT EXIST, honestly: `q` is how `tests/e2e/gallery.e2e.ts`
    // isolates its fixtures from a listing that is global by design, so every one of its
    // four rank assertions ran against a `?q=<nonce>` listing — i.e. the only listings the
    // spec ever inspected were filtered ones, which is exactly the case that is wrong. And
    // U-GV10's fake Prisma returns `rawRows` verbatim, so it cannot express filtering at
    // all. Both layers agreed with each other and neither agreed with the claim.
    const filtered = makeFake({ rawRows: threeRaw, items: threeRows });
    const { items } = await makeService(filtered).service.listGallery(null, {
      sort: "popular",
      q: "psalm",
    });
    expect(items.map((i) => i.rank)).toEqual([null, null, null]);
    // ...and the `q` really did reach the query, so this is rank SUPPRESSION and not a
    // parameter that got dropped on the way to the builder.
    expect(find(filtered.calls, "$queryRaw").args.sql.values).toContain("%psalm%");

    // The UNFILTERED listing still ranks: there the statement IS the whole ordering, so an
    // ordinal in it is a true global position.
    const unfiltered = makeFake({ rawRows: threeRaw, items: threeRows });
    const whole = await makeService(unfiltered).service.listGallery(null, {
      sort: "popular",
    });
    expect(whole.items.map((i) => i.rank)).toEqual([1, 2, 3]);

    // A BLANK `q` is ABSENT, not a filter: `parseSearchTerm` collapses it to `undefined`
    // and the builder emits no predicate at all. So it must NOT suppress the rank — and
    // that is why the gate reads the PARSED term rather than `query.q`. Gating on the raw
    // parameter would drop every rank in the product, because the UI's model always emits
    // `q=` whether or not the box has anything in it.
    const blank = makeFake({ rawRows: threeRaw, items: threeRows });
    const blankPage = await makeService(blank).service.listGallery(null, {
      sort: "popular",
      q: "   ",
    });
    expect(blankPage.items.map((i) => i.rank)).toEqual([1, 2, 3]);
  });

  it("U-GV11: exhaustion — pageSize+1 is fetched, pageSize is returned, and nextCursor is minted ONLY if the extra row existed", async () => {
    // 3 raw rows with pageSize 2 ⇒ there IS a next page.
    const more = makeFake({
      rawRows: threeRaw,
      items: threeRows,
    });
    const withMore = await makeService(more, { pageSize: 2 }).service.listGallery(
      null,
      { sort: "popular" },
    );
    expect(withMore.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(withMore.nextCursor).not.toBeNull();
    // The SQL asked for pageSize + 1, which is what makes the probe possible at all.
    expect(find(more.calls, "$queryRaw").args.sql.values).toContain(3);
    // Only the returned page's rows are fetched — never the probe row.
    expect(find(more.calls, "galleryItem.findMany").args.where).toMatchObject({
      id: { in: ["a", "b"] },
    });

    // Exactly pageSize raw rows ⇒ GENUINELY exhausted, so nextCursor is null and the UI
    // can hide "Load more" honestly.
    const exact = makeFake({
      rawRows: threeRaw.slice(0, 2),
      items: threeRows.slice(0, 2),
    });
    const atEnd = await makeService(exact, { pageSize: 2 }).service.listGallery(
      null,
      { sort: "popular" },
    );
    expect(atEnd.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(atEnd.nextCursor).toBeNull();

    // An empty result is exhausted too, and must not mint a cursor over nothing.
    const none = makeFake({ rawRows: [], items: [] });
    const empty = await makeService(none, { pageSize: 2 }).service.listGallery(null, {
      sort: "popular",
    });
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
    expect(has(none.calls, "galleryItem.findMany")).toBe(false);
  });

  it("U-GV11b: the minted cursor carries the last row's key, id and ordinal — and the epoch under trending", async () => {
    const popular = makeFake({ rawRows: threeRaw, items: threeRows });
    const p = await makeService(popular, { pageSize: 2 }).service.listGallery(null, {
      sort: "popular",
    });
    expect(p.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(p.nextCursor!, "base64url").toString("utf8"))).toEqual({
      s: "popular",
      k: 5, // row "b"'s sort key
      i: "b",
      n: 2,
    });

    const trending = makeFake({
      rawRows: [
        { id: "a", sortKey: 44.81 },
        { id: "b", sortKey: 0.35 },
        { id: "c", sortKey: 0.03 },
      ],
      items: threeRows,
    });
    const t = await makeService(trending, { pageSize: 2 }).service.listGallery(null, {
      sort: "trending",
    });
    const decoded = JSON.parse(
      Buffer.from(t.nextCursor!, "base64url").toString("utf8"),
    );
    // The epoch FREEZES `now` for the whole pagination run, so trending degrades to
    // popular's stability rather than drifting every second.
    expect(decoded.t).toBe(NOW.toISOString());
    expect(decoded).toMatchObject({ s: "trending", i: "b", n: 2 });
  });

  it("U-GV11d: with NO pageSize option the service uses GALLERY_PAGE_SIZE — the wireframe's 24, not an arbitrary default", async () => {
    // `pageSize` is a constructor option only so tests can use 2 (plan D5); `limit` is
    // deliberately NOT a client parameter, so this constant is the ONLY thing bounding a
    // public, unauthenticated listing. Nothing else pins the two together: every other
    // page-size assertion in this file passes an explicit override.
    const fake = makeFake({ rawRows: threeRaw, items: threeRows });
    await makeService(fake).service.listGallery(null, { sort: "popular" });
    expect(find(fake.calls, "$queryRaw").args.sql.values).toContain(
      GALLERY_PAGE_SIZE + 1,
    );
    expect(GALLERY_PAGE_SIZE).toBe(24);
  });

  it("U-GV11c: a malformed or sort-mismatched cursor is a 400-shaped error, raised BEFORE any query is issued", async () => {
    const bad = makeFake({ rawRows: threeRaw, items: threeRows });
    await expect(
      makeService(bad).service.listGallery(null, {
        sort: "popular",
        cursor: "not-a-cursor",
      }),
    ).rejects.toBeInstanceOf(InvalidGalleryCursorError);
    expect(has(bad.calls, "$queryRaw")).toBe(false);

    const mismatched = makeFake({ rawRows: threeRaw, items: threeRows });
    await expect(
      makeService(mismatched).service.listGallery(null, {
        sort: "newest",
        cursor: encodeCursor({ s: "popular", k: 1, i: "x", n: 1 }),
      }),
    ).rejects.toBeInstanceOf(InvalidGalleryCursorError);
    expect(has(mismatched.calls, "$queryRaw")).toBe(false);
  });

  it("U-GV14: every item in the page gets its thumbnail presigned at the 120 s TTL, and a signing failure degrades to null", async () => {
    const fake = makeFake({ rawRows: threeRaw, items: threeRows });
    const { service, presigned } = makeService(fake);
    const { items } = await service.listGallery(null, { sort: "popular" });

    expect(presigned).toHaveLength(3);
    for (const p of presigned) {
      expect(p.ttl).toBe(STREAM_TTL);
      expect(p.key).toBe(buildRenderThumbnailKey(RENDER_ID));
    }
    for (const item of items) {
      expect(item.thumbnailUrl).toContain(buildRenderThumbnailKey(RENDER_ID));
    }

    // An anonymous public grid must not 500 because one poster could not be signed.
    const failing = makeFake({ rawRows: threeRaw, items: threeRows });
    const { items: degraded } = await makeService(failing, {
      presignFails: true,
    }).service.listGallery(null, { sort: "popular" });
    expect(degraded.map((i) => i.thumbnailUrl)).toEqual([null, null, null]);
  });
});

// ================================================================ stream-url (D13)

describe("GalleryService.presignGalleryStream", () => {
  it("U-GV12: an unknown item 404s and the presign seam is NEVER called", async () => {
    const fake = makeFake({ item: null });
    const { service, presigned } = makeService(fake);
    await expect(service.presignGalleryStream("nope")).rejects.toBeInstanceOf(
      GalleryItemNotFoundError,
    );
    expect(presigned).toHaveLength(0);
  });

  it("U-GV13: it signs exactly buildRenderOutputKey(item.renderJobId) at the 120 s TTL — the route never accepts a key", async () => {
    const fake = makeFake({ item: itemRow() });
    const { service, presigned } = makeService(fake);
    const out = await service.presignGalleryStream("gal-1");

    expect(presigned).toEqual([
      { key: buildRenderOutputKey(RENDER_ID), ttl: STREAM_TTL },
    ]);
    expect(out.url).toContain(buildRenderOutputKey(RENDER_ID));
    expect(out.expiresAt).toEqual(new Date(NOW.getTime() + STREAM_TTL * 1000));
    // The URL IS the credential for an unauthenticated caller, so it is deliberately
    // shorter-lived than FilesService's 300 s default.
    expect(STREAM_TTL).toBeLessThan(300);
  });

  it("U-GV13c: the 120 s TTL is a real constructor option, not a hardcoded literal — an override reaches BOTH signers", async () => {
    // Plan D13 makes the TTL a `GalleryService` option rather than an env var (no
    // .env.example / compose / env.ts churn for a constant). Without this case the option
    // could be dead code and every other assertion here would still pass on a hardcoded
    // 120 — and the ONE place it would then silently fail is a future caller that needs a
    // different lifetime.
    const stream = makeFake({ item: itemRow() });
    const streamed = makeService(stream, { streamUrlTtlSeconds: 45 });
    const out = await streamed.service.presignGalleryStream("gal-1");
    expect(streamed.presigned).toEqual([
      { key: buildRenderOutputKey(RENDER_ID), ttl: 45 },
    ]);
    expect(out.expiresAt).toEqual(new Date(NOW.getTime() + 45_000));

    // The listing's poster URLs share the same lifetime — they are issued to the same
    // unauthenticated caller, so a split would be an accident, not a decision.
    const list = makeFake({
      rawRows: [{ id: "a", sortKey: 9 }],
      items: [itemRow({ id: "a" })],
    });
    const listed = makeService(list, { streamUrlTtlSeconds: 45 });
    await listed.service.listGallery(null, { sort: "popular" });
    expect(listed.presigned).toEqual([
      { key: buildRenderThumbnailKey(RENDER_ID), ttl: 45 },
    ]);
  });

  it("U-GV13b: an UNLISTED item still streams — unlisted means hidden from the listing, reachable by link", async () => {
    const fake = makeFake({ item: itemRow({ visibility: "unlisted" }) });
    const { service, presigned } = makeService(fake);
    await expect(service.presignGalleryStream("gal-1")).resolves.toMatchObject({
      url: expect.stringContaining(buildRenderOutputKey(RENDER_ID)),
    });
    expect(presigned).toHaveLength(1);
  });
});

// ==================================================================== delete (§3.1)

describe("GalleryService.deleteItem", () => {
  it("U-GV15: the delete is OWNER-SCOPED in one conditional write; a 0-row match 404s", async () => {
    const ok = makeFake({ deletedCount: 1 });
    await expect(
      makeService(ok).service.deleteItem(USER_ID, "gal-1"),
    ).resolves.toBeUndefined();
    expect(find(ok.calls, "galleryItem.deleteMany").args.where).toMatchObject({
      id: "gal-1",
      ownerId: USER_ID,
    });

    // A foreign item and a missing item are indistinguishable on the wire.
    const foreign = makeFake({ deletedCount: 0 });
    await expect(
      makeService(foreign).service.deleteItem(USER_ID, "gal-1"),
    ).rejects.toBeInstanceOf(GalleryItemNotFoundError);
  });
});

// ============================================================= upvotes — row 40 (D10)

describe("GalleryService.upvote", () => {
  it("U-UV1: BOTH writes land on the transaction client — never on the root client", async () => {
    const fake = makeFake({ item: itemRow(), createManyCount: 1 });
    await makeService(fake).service.upvote("voter-1", "gal-1");

    expect(has(fake.calls, "tx:galleryUpvote.createMany")).toBe(true);
    expect(has(fake.calls, "tx:galleryItem.update")).toBe(true);
    // The row 40 acceptance is "same transaction". If either write escaped to the root
    // client, a crash between them would leave the counter and the vote rows disagreeing
    // forever.
    expect(has(fake.calls, "galleryUpvote.createMany")).toBe(false);
    expect(has(fake.calls, "galleryItem.update")).toBe(false);
    expect(at(fake.calls, "$transaction")).toBeLessThan(
      at(fake.calls, "tx:galleryUpvote.createMany"),
    );
    expect(at(fake.calls, "tx:galleryUpvote.createMany")).toBeLessThan(
      at(fake.calls, "tx:galleryItem.update"),
    );
  });

  it("U-UV2: a first vote inserts with skipDuplicates and, because count === 1, increments", async () => {
    const fake = makeFake({ item: itemRow(), createManyCount: 1 });
    await makeService(fake).service.upvote("voter-1", "gal-1");

    const insert = find(fake.calls, "tx:galleryUpvote.createMany").args;
    // `skipDuplicates` compiles to INSERT … ON CONFLICT DO NOTHING, which is the whole
    // point: no exception is raised, so the transaction is never poisoned.
    expect(insert.skipDuplicates).toBe(true);
    expect(insert.data).toEqual([{ userId: "voter-1", galleryItemId: "gal-1" }]);
    expect(count(fake.calls, "tx:galleryItem.update")).toBe(1);
  });

  it("U-UV3: a DUPLICATE vote (count === 0) performs NO update — the count is stable", async () => {
    const fake = makeFake({ item: itemRow(), createManyCount: 0 });
    await makeService(fake).service.upvote("voter-1", "gal-1");

    expect(has(fake.calls, "tx:galleryUpvote.createMany")).toBe(true);
    expect(has(fake.calls, "tx:galleryItem.update")).toBe(false);
    expect(has(fake.calls, "tx:galleryItem.updateMany")).toBe(false);
  });

  it("U-UV4: the increment is EXACTLY { increment: 1 } — never a computed literal (the lost-update guard)", async () => {
    const fake = makeFake({ item: itemRow({ upvoteCount: 41 }), createManyCount: 1 });
    await makeService(fake).service.upvote("voter-1", "gal-1");

    const upd = find(fake.calls, "tx:galleryItem.update").args;
    expect(upd.where).toEqual({ id: "gal-1" });
    // Prisma compiles this to `SET "upvoteCount" = "upvoteCount" + 1`, which Postgres
    // re-reads under the row lock — so N concurrent votes from N users produce EXACTLY N.
    // A findUnique + update({ upvoteCount: n + 1 }) would pass a naive test and lose
    // updates under READ COMMITTED, so the shape is asserted exactly, not loosely.
    expect(upd.data).toEqual({ upvoteCount: { increment: 1 } });
    expect(upd.data.upvoteCount).not.toBe(42);
  });

  it("U-UV7: `create` is NEVER used for the vote — a P2002 inside a Postgres transaction aborts it (25P02) and Prisma issues no SAVEPOINT", async () => {
    for (const dup of [0, 1]) {
      const fake = makeFake({ item: itemRow(), createManyCount: dup });
      await makeService(fake).service.upvote("voter-1", "gal-1");
      expect(has(fake.calls, "tx:galleryUpvote.create"), `count=${dup}`).toBe(false);
      expect(has(fake.calls, "galleryUpvote.create"), `count=${dup}`).toBe(false);
    }
  });

  it("U-UV11: against a fake that models POSTGRES ABORT SEMANTICS, a duplicate vote still commits — no 25P02 anywhere", async () => {
    // U-UV2/U-UV3/U-UV7 above are MOCK-SHAPE assertions: they pin which Prisma method is
    // called, not what Postgres does to a transaction. An adversarial audit showed that is not
    // enough — the api e2e stayed 25/25 green against BOTH
    //   M3   `try { create } catch (P2002) { inserted = false }` gating the increment, and
    //   M3b  check-then-insert with a swallowed P2002,
    // and only went red on
    //   M3c  swallow the P2002 and then increment UNCONDITIONALLY.
    // So M3c is the shape the design is actually defending against, and until now nothing but
    // an expensive 8-request e2e burst held it.
    //
    // This fake is the missing behavioural pin. It models the ONE thing that matters and that
    // no mock-shape assertion can see: a unique violation raised inside an interactive
    // Postgres transaction marks the transaction ABORTED, after which EVERY further statement
    // fails with 25P02 — Prisma issues no SAVEPOINT. Run against the shipped
    // `createMany({ skipDuplicates })` (INSERT … ON CONFLICT DO NOTHING) nothing conflicts, so
    // nothing aborts. Run against M3c it raises 25P02 out of the increment.
    //
    // HONEST LIMIT, recorded rather than papered over: this does NOT distinguish the shipped
    // shape from M3/M3b, and nothing behavioural can — they are genuinely correct too. The
    // reasons to prefer `createMany` are that it makes the abort STRUCTURALLY impossible
    // instead of contingent on nobody ever adding a statement after the catch, and that it is
    // one round trip instead of two. That preference is pinned by U-UV2/U-UV3/U-UV7's shapes,
    // and this test says so out loud.
    const abortingPostgres = () => {
      const calls: Call[] = [];
      const existing = new Set<string>(["voter-1|gal-1"]); // the user ALREADY voted
      let aborted = false;
      let counter = 7;

      const guard = (op: string) => {
        calls.push({ op, args: {} });
        if (aborted) {
          const err: any = new Error(
            "current transaction is aborted, commands ignored until end of transaction block",
          );
          err.code = "25P02";
          throw err;
        }
      };
      const key = (d: { userId: string; galleryItemId: string }) =>
        `${d.userId}|${d.galleryItemId}`;

      const tx = {
        galleryUpvote: {
          create: (args: any) => {
            guard("tx:galleryUpvote.create");
            if (existing.has(key(args.data))) {
              // Postgres raises the unique violation AND poisons the transaction.
              aborted = true;
              const err: any = new Error(
                "Unique constraint failed on the fields: (`userId`,`galleryItemId`)",
              );
              err.code = "P2002";
              return Promise.reject(err);
            }
            existing.add(key(args.data));
            return Promise.resolve({ id: "vote-1" });
          },
          createMany: (args: any) => {
            guard("tx:galleryUpvote.createMany");
            const fresh = args.data.filter((d: any) => !existing.has(key(d)));
            for (const d of fresh) existing.add(key(d));
            return Promise.resolve({ count: fresh.length });
          },
          findFirst: (args: any) => {
            guard("tx:galleryUpvote.findFirst");
            return Promise.resolve(existing.has(key(args.where)) ? { id: "vote-1" } : null);
          },
          deleteMany: (args: any) => {
            guard("tx:galleryUpvote.deleteMany");
            const had = existing.delete(key(args.where));
            return Promise.resolve({ count: had ? 1 : 0 });
          },
        },
        galleryItem: {
          update: () => {
            guard("tx:galleryItem.update");
            counter += 1;
            return Promise.resolve({});
          },
          updateMany: () => {
            guard("tx:galleryItem.updateMany");
            counter -= 1;
            return Promise.resolve({ count: 1 });
          },
        },
      };

      const prisma = {
        galleryItem: {
          findFirst: () => {
            calls.push({ op: "galleryItem.findFirst", args: {} });
            return Promise.resolve(itemRow({ upvoteCount: counter }));
          },
        },
        galleryUpvote: {
          findMany: () => {
            calls.push({ op: "galleryUpvote.findMany", args: {} });
            return Promise.resolve([{ galleryItemId: "gal-1" }]);
          },
        },
        $transaction: async (fn: any) => {
          calls.push({ op: "$transaction", args: {} });
          return fn(tx);
        },
      };
      return {
        fake: { prisma: prisma as unknown as PrismaClient, calls },
        counter: () => counter,
        votes: () => existing.size,
      };
    };

    const pg = abortingPostgres();
    const dto = await makeService(pg.fake).service.upvote("voter-1", "gal-1");

    // It commits, the count is stable, and no second vote row appeared.
    expect(dto.upvoteCount).toBe(7);
    expect(pg.counter()).toBe(7);
    expect(pg.votes()).toBe(1);
    // The proof that the abort was never triggered: `create` was not the statement used, so
    // there was no P2002 to swallow and nothing that could poison what follows.
    expect(has(pg.fake.calls, "tx:galleryUpvote.create")).toBe(false);
    expect(has(pg.fake.calls, "tx:galleryUpvote.createMany")).toBe(true);
    expect(has(pg.fake.calls, "tx:galleryItem.update")).toBe(false);

    // …and a FIRST vote through the same fake still increments, so the assertion above is not
    // passing merely because the path does nothing.
    const fresh = abortingPostgres();
    const first = await makeService(fresh.fake).service.upvote("voter-2", "gal-1");
    expect(fresh.counter()).toBe(8);
    expect(first.upvoteCount).toBe(8);
    expect(has(fresh.fake.calls, "tx:galleryItem.update")).toBe(true);
  });

  it("U-UV8: voting on an unknown item 404s and NO transaction is opened", async () => {
    const fake = makeFake({ item: null });
    await expect(
      makeService(fake).service.upvote("voter-1", "nope"),
    ).rejects.toBeInstanceOf(GalleryItemNotFoundError);
    expect(has(fake.calls, "$transaction")).toBe(false);
  });

  it("U-UV9: voting on an UNLISTED item is allowed — it is reachable by link by design", async () => {
    const fake = makeFake({
      item: itemRow({ visibility: "unlisted" }),
      createManyCount: 1,
    });
    const dto = await makeService(fake).service.upvote("voter-1", "gal-1");
    expect(dto.visibility).toBe("unlisted");
    expect(has(fake.calls, "tx:galleryItem.update")).toBe(true);
  });

  it("U-UV10: the reply is the POST-transaction item — fresh count, viewerHasUpvoted true", async () => {
    const fake = makeFake({
      item: itemRow({ upvoteCount: 7 }),
      reReadItem: itemRow({ upvoteCount: 8 }),
      createManyCount: 1,
      votes: [{ galleryItemId: "gal-1" }],
    });
    const dto = await makeService(fake).service.upvote("voter-1", "gal-1");

    expect(dto.upvoteCount).toBe(8);
    expect(dto.viewerHasUpvoted).toBe(true);
    // The re-read happens AFTER the transaction commits, so the UI can reconcile its
    // optimistic update against server truth in one round trip.
    expect(at(fake.calls, "$transaction")).toBeLessThan(
      at(fake.calls, "galleryUpvote.findMany"),
    );
    // Rank is a property of the global popular ordering; a single-item reply has none.
    expect(dto.rank).toBeNull();
  });
});

describe("GalleryService.removeUpvote", () => {
  it("U-UV5: an existing vote is deleted and the counter decremented; a missing vote changes nothing", async () => {
    const had = makeFake({
      item: itemRow({ upvoteCount: 8 }),
      reReadItem: itemRow({ upvoteCount: 7 }),
      deleteVoteCount: 1,
    });
    const dto = await makeService(had).service.removeUpvote("voter-1", "gal-1");
    const del = find(had.calls, "tx:galleryUpvote.deleteMany").args;
    expect(del.where).toEqual({ userId: "voter-1", galleryItemId: "gal-1" });
    expect(has(had.calls, "tx:galleryItem.updateMany")).toBe(true);
    expect(dto.upvoteCount).toBe(7);
    expect(dto.viewerHasUpvoted).toBe(false);

    // `deleteMany` returns count 0 for a missing row and RAISES NOTHING (unlike
    // `delete`, which throws P2025), so un-voting something you never voted for is a
    // silent no-op rather than an error.
    const never = makeFake({ item: itemRow({ upvoteCount: 8 }), deleteVoteCount: 0 });
    await expect(
      makeService(never).service.removeUpvote("voter-1", "gal-1"),
    ).resolves.toMatchObject({ upvoteCount: 8 });
    expect(has(never.calls, "tx:galleryItem.updateMany")).toBe(false);
    expect(has(never.calls, "tx:galleryItem.update")).toBe(false);
  });

  it("U-UV6: the decrement carries the upvoteCount > 0 FLOOR GUARD, so the counter can never go negative", async () => {
    const fake = makeFake({
      item: itemRow({ upvoteCount: 1 }),
      reReadItem: itemRow({ upvoteCount: 0 }),
      deleteVoteCount: 1,
    });
    await makeService(fake).service.removeUpvote("voter-1", "gal-1");

    const upd = find(fake.calls, "tx:galleryItem.updateMany").args;
    expect(upd.where).toEqual({ id: "gal-1", upvoteCount: { gt: 0 } });
    expect(upd.data).toEqual({ upvoteCount: { decrement: 1 } });
  });

  it("U-UV8b: un-voting an unknown item 404s and opens no transaction", async () => {
    const fake = makeFake({ item: null });
    await expect(
      makeService(fake).service.removeUpvote("voter-1", "nope"),
    ).rejects.toBeInstanceOf(GalleryItemNotFoundError);
    expect(has(fake.calls, "$transaction")).toBe(false);
  });

  it("U-UV1b: the unvote's writes also land on the transaction client only", async () => {
    const fake = makeFake({
      item: itemRow({ upvoteCount: 3 }),
      deleteVoteCount: 1,
    });
    await makeService(fake).service.removeUpvote("voter-1", "gal-1");
    expect(has(fake.calls, "tx:galleryUpvote.deleteMany")).toBe(true);
    expect(has(fake.calls, "tx:galleryItem.updateMany")).toBe(true);
    expect(has(fake.calls, "galleryUpvote.deleteMany")).toBe(false);
    expect(has(fake.calls, "galleryItem.updateMany")).toBe(false);
  });
});
