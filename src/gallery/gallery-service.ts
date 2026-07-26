import {
  buildRenderOutputKey,
  buildRenderThumbnailKey,
  deriveScriptureBook,
  type GalleryItemDto,
  type GalleryListQuery,
  type PrismaClient,
  type PublishGalleryItemRequest,
} from "@supagloo/database-lib";
import { toGalleryItemDto, type GalleryItemRow } from "./dto";
import {
  buildGalleryListQuery,
  encodeCursor,
  parseCursor,
  parseSearchTerm,
  GALLERY_PAGE_SIZE,
} from "./gallery-query";
import {
  GalleryItemAlreadyPublishedError,
  GalleryItemNotFoundError,
  InvalidGalleryCursorError,
  InvalidGallerySearchError,
  RenderNotPublishableError,
  ScriptureBookUnderivableError,
} from "./errors";

/**
 * The gallery service (Tasks #39 + #40, design-delta §2.7/§6c/§8, plan D4–D13).
 *
 * Publish is what §7 calls "a single Postgres insert — plain API CRUD": no workflow, no
 * provider egress, no GitHub read. The listing is one raw keyset query (ordering +
 * pagination) plus one typed `findMany` (row → DTO), plus local URL signing. Nothing here
 * touches the network except S3 presigning, which `getSignedUrl` does OFFLINE.
 *
 * Every seam is injected so the whole surface is unit-testable DB-free:
 *   - `prisma` — the client (or a transaction-aware fake);
 *   - `presignPublic` — the OWNERSHIP-FREE signer (`FilesService.presignPublicKey`), kept
 *     as a narrow seam so the gallery's "published, not owned" authorization rule can never
 *     leak onto `GET /v1/files/presign-download` (plan D13);
 *   - `now` — the clock, so the trending epoch is deterministic;
 *   - `streamUrlTtlSeconds` — 120 s, a constructor option rather than an env var (no
 *     `.env.example` / compose / `env.ts` churn for a constant);
 *   - `pageSize` — `GALLERY_PAGE_SIZE`, overridable so tests can walk pages with 2.
 */
export interface GalleryServiceOptions {
  prisma: PrismaClient;
  /**
   * Sign a GET URL for `key` with NO ownership check, for `ttlSeconds`.
   *
   * The authorization is the ROW, not the key: the item must exist (both `public` and
   * `unlisted` are served), and no caller ever supplies a key — the service recomputes it
   * from `renderJobId` with the shared db-lib builders.
   */
  presignPublic: (
    key: string,
    ttlSeconds: number,
  ) => Promise<{ url: string; expiresAt: Date }>;
  /** Injectable clock. Defaults to wall-clock. */
  now?: () => Date;
  /**
   * Lifetime of the stream URL and of each listing poster URL. Default 120 s — shorter
   * than `FilesService`'s 300 s because the URL is issued to an UNAUTHENTICATED caller, so
   * the URL *is* the credential. Two minutes is ample for a `<video>` to begin (the browser
   * requests it immediately) and short enough that a pasted URL is not a durable public
   * mirror.
   *
   * HONEST LIMITATION: an HTTP range session already in flight continues past expiry. The
   * TTL bounds NEW requests, not the stream currently being served.
   */
  streamUrlTtlSeconds?: number;
  /** Rows per page. Default {@link GALLERY_PAGE_SIZE}. */
  pageSize?: number;
}

export interface GalleryPage {
  items: GalleryItemDto[];
  /** `null` means GENUINELY exhausted (the pageSize+1 probe found no extra row). */
  nextCursor: string | null;
}

/** The owner columns every read pulls alongside the item, for the card's byline. */
const OWNER_INCLUDE = {
  owner: { select: { displayName: true, avatarInitials: true } },
} as const;

/**
 * A unique-constraint violation, duck-typed on the Prisma error code rather than
 * `instanceof PrismaClientKnownRequestError`.
 *
 * Duck-typing is deliberate: the check must stay NARROW (an unrelated failure must never be
 * reported as `already_published`) while remaining assertable without constructing a real
 * Prisma error object in tests.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/** Normalize a raw `sortKey` into the JSON-safe shape the cursor carries. `newest` keys
 *  come back from Postgres as `Date` objects; the cursor transports them as ISO strings. */
function toCursorKey(raw: unknown): number | string {
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === "number" || typeof raw === "string") return raw;
  return Number(raw);
}

export class GalleryService {
  private readonly prisma: PrismaClient;
  private readonly presignPublic: GalleryServiceOptions["presignPublic"];
  private readonly now: () => Date;
  private readonly streamUrlTtlSeconds: number;
  private readonly pageSize: number;

  constructor(opts: GalleryServiceOptions) {
    this.prisma = opts.prisma;
    this.presignPublic = opts.presignPublic;
    this.now = opts.now ?? (() => new Date());
    this.streamUrlTtlSeconds = opts.streamUrlTtlSeconds ?? 120;
    this.pageSize = opts.pageSize ?? GALLERY_PAGE_SIZE;
  }

  // ------------------------------------------------------------------- publish (D7/D8)

  /**
   * Publish a completed render to the gallery.
   *
   * The render is resolved OWNER-SCOPED, so an unknown id and another user's id are
   * indistinguishable (404). Three of the columns the row needs are not on `RenderJob`:
   *   - `durationSeconds` is derived SERVER-SIDE as `max(1, round(framesTotal / fps))` —
   *     the only one the server actually knows, and letting the client claim a duration
   *     would let the `mm:ss` badge lie about its own video;
   *   - `scriptureReference` + `translation` come from the REQUEST BODY, because reading
   *     them from the repo manifest would put real GitHub egress into a single-insert path,
   *     drag this endpoint's e2e under the real-provider policy, and still not answer which
   *     of an N-scene manifest's N references is the card's;
   *   - `scriptureBook` is DERIVED from the reference (a null derivation is a 422).
   *
   * Both asset keys are RECOMPUTED from the shared db-lib builders, never read from the
   * stored strings and never taken from the client — exactly as
   * `RendersService.presignRenderDownload` already does — so the persisted keys are always
   * ones `parseS3Key` can resolve.
   */
  async publish(
    userId: string,
    renderJobId: string,
    req: PublishGalleryItemRequest,
  ): Promise<GalleryItemDto> {
    const render = await this.prisma.renderJob.findFirst({
      where: { id: renderJobId, userId },
    });
    if (!render) {
      throw new GalleryItemNotFoundError("render not found");
    }

    if (render.status !== "completed") {
      throw new RenderNotPublishableError(
        `render is ${render.status}, not completed`,
      );
    }
    if (!render.outputAssetKey || !render.thumbnailAssetKey) {
      throw new RenderNotPublishableError("render has no output asset");
    }
    if (render.framesTotal <= 0) {
      throw new RenderNotPublishableError("render has no resolved duration");
    }

    const scriptureBook = deriveScriptureBook(req.scriptureReference);
    if (!scriptureBook) {
      throw new ScriptureBookUnderivableError(
        `cannot derive a scripture book from "${req.scriptureReference}"`,
      );
    }

    const durationSeconds = Math.max(
      1,
      Math.round(render.framesTotal / render.fps),
    );

    let row: GalleryItemRow;
    try {
      row = (await this.prisma.galleryItem.create({
        data: {
          renderJobId: render.id,
          projectId: render.projectId,
          ownerId: userId,
          title: req.title,
          description: req.description,
          scriptureReference: req.scriptureReference,
          translation: req.translation,
          scriptureBook,
          durationSeconds,
          videoAssetKey: buildRenderOutputKey(render.id),
          thumbnailAssetKey: buildRenderThumbnailKey(render.id),
          visibility: req.visibility,
        },
        include: OWNER_INCLUDE,
      })) as GalleryItemRow;
    } catch (err) {
      // `renderJobId` is @unique, so a second publish of the same render lands here.
      if (isUniqueViolation(err)) throw new GalleryItemAlreadyPublishedError();
      throw err;
    }

    // A fresh item has no votes and no rank; the card still needs a poster immediately.
    return this.toDto(row, { rank: null, viewerHasUpvoted: false });
  }

  // -------------------------------------------------------------------- read (D11/D12)

  /**
   * The public listing. `visibility='public'` ONLY — `unlisted` never appears, not even for
   * its owner: the listing is ONE public projection, and making it viewer-dependent would
   * make the cursor, the ranks and any future caching viewer-dependent too. ("Your videos"
   * is where an owner sees their own work.)
   *
   * Raw SQL owns ordering + pagination; the rows themselves are fetched by the typed client
   * and re-ordered in JS to the id order the SQL produced — `findMany({ id: { in } })` gives
   * NO ordering guarantee.
   *
   * Because it IS two queries, a page may come back SHORTER than `pageSize` with a non-null
   * `nextCursor`. That is not a bug and not exhaustion: it means a row was deleted between the
   * ordering query and the typed read. Every coordinate the cursor carries comes from the
   * ORDERING, so pagination continues from the right place and only that one row is missing
   * from this page. `nextCursor === null` remains the ONLY exhaustion signal.
   */
  async listGallery(
    viewerId: string | null,
    query: GalleryListQuery,
  ): Promise<GalleryPage> {
    const parsed = parseCursor(query.cursor, query.sort);
    if (!parsed.ok) throw new InvalidGalleryCursorError(parsed.reason);
    const cursor = parsed.cursor;

    // Both client-supplied parameters are validated BEFORE any SQL exists, and both are
    // 400s: a control character in `q` is a NUL away from `22021` and an over-long `q` is
    // three unbounded `ILIKE '%…%'` scans per row on an anonymous endpoint.
    const search = parseSearchTerm(query.q);
    if (!search.ok) throw new InvalidGallerySearchError(search.reason);

    const { sql, epoch } = buildGalleryListQuery({
      sort: query.sort,
      cursor,
      now: this.now(),
      pageSize: this.pageSize,
      q: search.q,
    });

    const raw = await this.prisma.$queryRaw<
      Array<{ id: string; sortKey: unknown }>
    >(sql);

    // The pageSize+1 probe: its presence is the ONLY thing that mints a nextCursor, which
    // is what lets `nextCursor === null` mean "genuinely exhausted" rather than "short
    // page" — and therefore lets the UI hide "Load more" honestly.
    const hasMore = raw.length > this.pageSize;
    const page = raw.slice(0, this.pageSize);
    if (page.length === 0) return { items: [], nextCursor: null };

    const ids = page.map((r) => r.id);
    const rows = (await this.prisma.galleryItem.findMany({
      where: { id: { in: ids } },
      include: OWNER_INCLUDE,
    })) as GalleryItemRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((r): r is GalleryItemRow => r !== undefined);

    const voted = await this.resolveViewerVotes(viewerId, ids);

    // `rank` is 1-based and CONTINUOUS ACROSS PAGES: the cursor's `n` supplies the starting
    // ordinal, so page 2 of a 24-row page carries 25…48. A client computing `index + 1`
    // would badge the 25th item "#1". It is non-null only under `popular`, because rank is
    // a property of the GLOBAL popular ordering and a "#7" under another ordering asserts
    // something untrue.
    //
    // ...and for the SAME reason it is non-null only on an UNFILTERED listing. The `q`
    // ILIKE predicate lives in the same `WHERE` as this statement's `ORDER BY` and `LIMIT`,
    // so with a search term `startOrdinal + index + 1` is a position AMONG THE HITS, not a
    // position in the ordering. Badging the top match "#1" when it is #400 globally is the
    // very claim the paragraph above refuses to make for `newest` and `trending`; a search
    // narrows the population exactly the way a different sort reorders it. The gate reads
    // the PARSED term, so a blank `q=` — which emits no predicate at all — still ranks.
    //
    // The ordinal is keyed off the position the RAW QUERY gave each id, NOT off this page's
    // surviving rows. That difference is only visible when a row vanishes between the two
    // queries (a concurrent `DELETE /v1/gallery/:id`), and it is the whole point: ranks are
    // positions in the global ordering, so the survivors must keep the numbers the ordering
    // gave them. Indexing off `ordered` instead renumbered them — losing row 2 of 3 badged
    // the third item "#2" — while `nextCursor.n` advanced by the SQL page's length, so the
    // next page also started one rank too high. A truthful GAP (1, 3) beats a silent shift,
    // and it keeps `n` in one coordinate system.
    const startOrdinal = cursor?.n ?? 0;
    const ordinalById = new Map(
      page.map((r, index) => [r.id, startOrdinal + index + 1]),
    );
    const items = await Promise.all(
      ordered.map((row) =>
        this.toDto(row, {
          rank:
            query.sort === "popular" && search.q === undefined
              ? (ordinalById.get(row.id) ?? null)
              : null,
          viewerHasUpvoted: voted.has(row.id),
        }),
      ),
    );

    const last = page[page.length - 1];
    const nextCursor = hasMore
      ? encodeCursor({
          s: query.sort,
          k: toCursorKey(last.sortKey),
          i: last.id,
          n: startOrdinal + page.length,
          // Trending FREEZES the epoch for the whole run, so only `upvoteCount` can move a
          // key — i.e. trending degrades exactly to popular's stability instead of drifting
          // every second.
          ...(query.sort === "trending"
            ? { t: epoch.toISOString() }
            : {}),
        })
      : null;

    return { items, nextCursor };
  }

  /**
   * One item by id, for BOTH visibilities: `unlisted` means hidden from the listing,
   * reachable by link. A row that does not exist is a uniform 404.
   */
  async getItem(
    viewerId: string | null,
    id: string,
  ): Promise<GalleryItemDto> {
    const row = (await this.prisma.galleryItem.findFirst({
      where: { id },
      include: OWNER_INCLUDE,
    })) as GalleryItemRow | null;
    if (!row) throw new GalleryItemNotFoundError();

    const voted = await this.resolveViewerVotes(viewerId, [row.id]);
    return this.toDto(row, {
      rank: null,
      viewerHasUpvoted: voted.has(row.id),
    });
  }

  // ------------------------------------------------------------------ stream-url (D13)

  /**
   * Presign the item's video for playback. The route NEVER accepts a key — it is recomputed
   * from `item.renderJobId` — and this is the first presign the process issues to a caller
   * who owns nothing, which is exactly why it goes through the narrow `presignPublic` seam
   * rather than teaching `assertOwnership` about gallery visibility.
   */
  async presignGalleryStream(
    id: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const item = await this.prisma.galleryItem.findFirst({
      where: { id },
      select: { renderJobId: true },
    });
    if (!item) throw new GalleryItemNotFoundError();

    return this.presignPublic(
      buildRenderOutputKey(item.renderJobId),
      this.streamUrlTtlSeconds,
    );
  }

  // ----------------------------------------------------------------------- delete (§3.1)

  /**
   * Un-publish. One conditional write scoped to the owner, so a foreign item and a missing
   * item are indistinguishable (404) without a separate read.
   *
   * Deleting CASCADES the item's `GalleryUpvote` rows and frees the `renderJobId` unique
   * slot, so a render can be un-published and re-published. The S3 objects are deliberately
   * NOT deleted — that is the cleanup workflow's job (current-design §6).
   */
  async deleteItem(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.galleryItem.deleteMany({
      where: { id, ownerId: userId },
    });
    if (count === 0) throw new GalleryItemNotFoundError();
  }

  // --------------------------------------------------------------- upvotes — row 40 (D10)

  /**
   * Cast the caller's vote. Idempotent: a duplicate is a 200 no-op with a stable count.
   *
   * THE TRAP, STATED PRECISELY (an earlier version of this comment overstated it, and an
   * adversarial audit was right to refute it). Catching a P2002 inside an interactive Postgres
   * transaction does not UNDO it: Postgres marks the transaction aborted and every SUBSEQUENT
   * statement fails with `25P02`, because Prisma's `$transaction` issues no SAVEPOINT. So what
   * is actually broken is `try { create } catch (P2002) {}` followed by ANY further statement
   * — swallow the conflict and then increment unconditionally, and the increment raises
   * 25P02. That shape is caught (E-U3 and E-U5 both fail on it).
   *
   * What is NOT true, and was claimed here before: that every `try { create } catch (P2002) }`
   * shape is broken. One that also SKIPS the increment behaves correctly today, and no
   * behavioural test can tell it from this code — measured, not assumed.
   *
   * `createMany({ skipDuplicates })` compiles to `INSERT … ON CONFLICT DO NOTHING`, which
   * raises nothing at all, and the returned count is what decides whether the counter moves.
   * It is preferred for two reasons that are about the CODE rather than the behaviour: it
   * makes the aborted-transaction state structurally unreachable instead of contingent on
   * nobody ever adding a statement after the catch, and it is one round trip instead of two.
   * That preference is therefore pinned by the SHAPE assertions U-UV2/U-UV3/U-UV7, and the
   * 25P02 hazard itself by U-UV11, which drives this method against a fake that models
   * Postgres's abort semantics.
   *
   * `{ increment: 1 }` is mandatory and a read-then-write is forbidden: Prisma compiles it
   * to `SET "upvoteCount" = "upvoteCount" + 1`, which Postgres re-reads under the row lock,
   * so N concurrent votes from N distinct users produce EXACTLY N. A `findUnique` +
   * `update({ upvoteCount: n + 1 })` would pass a sequential test and lose updates under
   * READ COMMITTED.
   *
   * Voting on an `unlisted` item is allowed — it is reachable by link by design.
   */
  async upvote(userId: string, galleryItemId: string): Promise<GalleryItemDto> {
    await this.requireItem(galleryItemId);

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.galleryUpvote.createMany({
        data: [{ userId, galleryItemId }],
        skipDuplicates: true,
      });
      if (count === 1) {
        await tx.galleryItem.update({
          where: { id: galleryItemId },
          data: { upvoteCount: { increment: 1 } },
        });
      }
    });

    // Re-read AFTER the commit so the UI can reconcile its optimistic update against server
    // truth in one round trip.
    return this.getItem(userId, galleryItemId);
  }

  /**
   * Withdraw the caller's vote. `deleteMany` returns `count: 0` for a missing row and raises
   * NOTHING (unlike `delete`, which throws P2025), so un-voting something you never voted
   * for is a silent 200 no-op rather than an error.
   *
   * The decrement carries a `upvoteCount: { gt: 0 }` floor guard. It costs nothing and makes
   * `upvoteCount >= 0` unbreakable even if the counter were ever corrupted out-of-band.
   */
  async removeUpvote(
    userId: string,
    galleryItemId: string,
  ): Promise<GalleryItemDto> {
    await this.requireItem(galleryItemId);

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.galleryUpvote.deleteMany({
        where: { userId, galleryItemId },
      });
      if (count === 1) {
        await tx.galleryItem.updateMany({
          where: { id: galleryItemId, upvoteCount: { gt: 0 } },
          data: { upvoteCount: { decrement: 1 } },
        });
      }
    });

    return this.getItem(userId, galleryItemId);
  }

  // ------------------------------------------------------------------------- internals

  /** Resolve the item BEFORE opening a transaction, so an unknown id is a 404 that costs no
   *  transaction at all. Uniform denial: existence never leaks. */
  private async requireItem(id: string): Promise<void> {
    const item = await this.prisma.galleryItem.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!item) throw new GalleryItemNotFoundError();
  }

  /**
   * The viewer's votes across a whole page, in ONE query (`galleryItemId: { in: ids }`) —
   * the N+1 guard. An ANONYMOUS viewer costs no query at all, which matters: the listing is
   * the one endpoint an unauthenticated crawler hits.
   */
  private async resolveViewerVotes(
    viewerId: string | null,
    ids: string[],
  ): Promise<Set<string>> {
    if (!viewerId || ids.length === 0) return new Set();
    const votes = await this.prisma.galleryUpvote.findMany({
      where: { userId: viewerId, galleryItemId: { in: ids } },
      select: { galleryItemId: true },
    });
    return new Set(votes.map((v) => v.galleryItemId));
  }

  /**
   * Sign the item's poster.
   *
   * The listing signs each poster ITSELF because `GET /v1/files/presign-download` is
   * auth+ownership-scoped and could never serve an anonymous grid. It is cheap rather than
   * 24 round trips: `getSignedUrl` signs LOCALLY — no network call — so a full page is
   * sub-millisecond CPU.
   *
   * A signing failure degrades to `null` instead of failing the request: an anonymous public
   * grid must not 500 because one poster could not be signed.
   */
  private async presignThumbnail(renderJobId: string): Promise<string | null> {
    try {
      const { url } = await this.presignPublic(
        buildRenderThumbnailKey(renderJobId),
        this.streamUrlTtlSeconds,
      );
      return url;
    } catch {
      return null;
    }
  }

  private async toDto(
    row: GalleryItemRow,
    extras: { rank: number | null; viewerHasUpvoted: boolean },
  ): Promise<GalleryItemDto> {
    return toGalleryItemDto(row, {
      thumbnailUrl: await this.presignThumbnail(row.renderJobId),
      rank: extras.rank,
      viewerHasUpvoted: extras.viewerHasUpvoted,
    });
  }
}
