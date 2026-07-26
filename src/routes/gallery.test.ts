import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { GalleryItemDtoSchema } from "@supagloo/database-lib";
import { bearerAuthPlugin } from "../auth/bearer-auth";
import { registerGalleryRoutes } from "./gallery";
import {
  GalleryItemAlreadyPublishedError,
  GalleryItemNotFoundError,
  InvalidGalleryCursorError,
  RenderNotPublishableError,
  ScriptureBookUnderivableError,
} from "../gallery/errors";

// Thin-handler wiring for the Task #39/#40 gallery endpoints. Isolated from the DB with a
// FAKE service + FAKE auth, driven via app.inject. What this file owns:
//
//   - the AUTH SHAPE PER ROUTE, which is the unusual thing about this surface: three
//     routes are reachable with no session at all. `GET /gallery` and `GET /gallery/:id`
//     use `optionalAuth` (resolve-if-present, NEVER 401 — a stale cookie must not turn a
//     public gallery into an error page), and `GET /gallery/:id/stream-url` takes no auth
//     hook whatsoever;
//   - the status-code map: 201 publish / 400 Zod + invalid_cursor / 401 no bearer /
//     404 uniform denial / 409 render_not_publishable + already_published /
//     422 scripture_book_underivable / 200 for a duplicate vote (NOT 409);
//   - that every route declares a complete `response` map, so an error reply is
//     serialized against a schema rather than leaking whatever the handler returned.

const fakeAuthService = {
  authenticate: async (token: string) =>
    token === "valid" ? { user: { id: "u1" }, session: { id: "s1" } } : null,
};

/** A complete, schema-valid GalleryItemDto — the response serializer validates it. */
const ITEM = {
  id: "gal-1",
  renderJobId: "render-1",
  projectId: "proj-1",
  title: "He Who Dwells",
  description: "Psalm 91 in nine scenes.",
  scriptureReference: "Psalm 91:1",
  scriptureBook: "PSA",
  translation: "BSB",
  durationSeconds: 30,
  visibility: "public" as const,
  publishedAt: "2026-07-25T09:00:00.000Z",
  upvoteCount: 7,
  thumbnailUrl: "https://s3.test/renders/render-1/thumb.jpg?sig=1",
  rank: 1,
  viewerHasUpvoted: false,
  owner: { displayName: "Mary K", avatarInitials: "MK" },
};

const EXPIRES = new Date("2026-07-26T12:02:00.000Z");

const PUBLISH_BODY = {
  title: "He Who Dwells",
  description: "Psalm 91 in nine scenes.",
  scriptureReference: "Psalm 91:1",
  translation: "BSB",
  visibility: "public",
};

/** Records what each handler passed the service, so "the viewer id reached the service"
 *  is assertable rather than inferred from a status code. */
interface Seen {
  listViewer?: string | null;
  listQuery?: unknown;
  getViewer?: string | null;
  publishUser?: string | null;
  deleteUser?: string | null;
  voteUser?: string | null;
  unvoteUser?: string | null;
  streamId?: string;
}

function makeService(overrides: Record<string, any> = {}) {
  const seen: Seen = {};
  const service = {
    publish: async (userId: string) => {
      seen.publishUser = userId;
      return { ...ITEM };
    },
    deleteItem: async (userId: string) => {
      seen.deleteUser = userId;
    },
    listGallery: async (viewerId: string | null, query: unknown) => {
      seen.listViewer = viewerId;
      seen.listQuery = query;
      return { items: [{ ...ITEM }], nextCursor: null };
    },
    getItem: async (viewerId: string | null) => {
      seen.getViewer = viewerId;
      return { ...ITEM };
    },
    presignGalleryStream: async (id: string) => {
      seen.streamId = id;
      return {
        url: "https://s3.test/renders/render-1/output.mp4?sig=1",
        expiresAt: EXPIRES,
      };
    },
    upvote: async (userId: string) => {
      seen.voteUser = userId;
      return { ...ITEM, upvoteCount: 8, viewerHasUpvoted: true };
    },
    removeUpvote: async (userId: string) => {
      seen.unvoteUser = userId;
      return { ...ITEM, upvoteCount: 7, viewerHasUpvoted: false };
    },
    ...overrides,
  } as any;
  return { service, seen };
}

interface CapturedRoute {
  method: string;
  url: string;
  response: Record<string, unknown>;
  preHandlers: unknown[];
}

async function buildTestApp(
  service: any,
): Promise<{ app: FastifyInstance; routes: CapturedRoute[] }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const routes: CapturedRoute[] = [];
  app.addHook("onRoute", (r) => {
    const pre = (r as any).preHandler;
    routes.push({
      method: Array.isArray(r.method) ? r.method.join(",") : String(r.method),
      url: r.url,
      response: ((r.schema as any)?.response ?? {}) as Record<string, unknown>,
      preHandlers: pre === undefined ? [] : Array.isArray(pre) ? pre : [pre],
    });
  });
  await app.register(bearerAuthPlugin, { authService: fakeAuthService as any });
  registerGalleryRoutes(app, { service });
  await app.ready();
  return { app, routes };
}

const BEARER = { authorization: "Bearer valid" };
const BAD_BEARER = { authorization: "Bearer stale-cookie" };

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

// ------------------------------------------------------- GET /gallery (optionalAuth)

describe("GET /gallery — the public listing", () => {
  it("U-GR1: with NO Authorization header at all ⇒ 200 and an anonymous viewer", async () => {
    const { service, seen } = makeService();
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({ method: "GET", url: "/gallery" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.nextCursor).toBeNull();
    expect(GalleryItemDtoSchema.safeParse(body.items[0]).success).toBe(true);
    expect(seen.listViewer).toBeNull();
    // `sort` defaults at the Zod boundary, so the service never has to guess.
    expect(seen.listQuery).toMatchObject({ sort: "popular" });
  });

  it("U-GR2: a PRESENT-BUT-INVALID token ⇒ 200 ANONYMOUS, not 401 (D2)", async () => {
    const { service, seen } = makeService();
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({
      method: "GET",
      url: "/gallery",
      headers: BAD_BEARER,
    });

    // The BFF forwards whatever session cookie is present, so 401-ing a stale one would
    // hand an error page to exactly the population most likely to hold one.
    expect(res.statusCode).toBe(200);
    expect(seen.listViewer).toBeNull();
  });

  it("U-GR3: a valid token ⇒ 200 and the service receives the VIEWER id", async () => {
    const { service, seen } = makeService();
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({
      method: "GET",
      url: "/gallery?sort=newest&q=shepherd",
      headers: BEARER,
    });

    expect(res.statusCode).toBe(200);
    expect(seen.listViewer).toBe("u1");
    expect(seen.listQuery).toMatchObject({ sort: "newest", q: "shepherd" });
  });

  it("U-GR4: an out-of-enum sort is rejected at the Zod boundary (400) and never reaches the service", async () => {
    let called = false;
    const { service } = makeService({
      listGallery: async () => {
        called = true;
        return { items: [], nextCursor: null };
      },
    });
    const built = await buildTestApp(service);
    app = built.app;

    for (const url of ["/gallery?sort=hot", "/gallery?sort=", "/gallery?sort=POPULAR"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
    }
    // The closed enum is what lets the SQL builder pick its ORDER BY from a fixed map.
    expect(called).toBe(false);
  });

  it("U-GR5: a malformed or sort-mismatched cursor ⇒ 400 invalid_cursor", async () => {
    const { service } = makeService({
      listGallery: async () => {
        throw new InvalidGalleryCursorError();
      },
    });
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({ method: "GET", url: "/gallery?cursor=zzz" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_cursor");
  });

  it("U-GR5b: a blank `q` is accepted (a UI that always appends the param must not 400)", async () => {
    const { service, seen } = makeService();
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({ method: "GET", url: "/gallery?q=" });
    expect(res.statusCode).toBe(200);
    expect(seen.listQuery).toMatchObject({ q: "" });
  });
});

// ---------------------------------------------- GET /gallery/:id + /:id/stream-url

describe("GET /gallery/:id and /gallery/:id/stream-url", () => {
  it("U-GR6: an unknown item 404s `not_found`; a known item is 200 for an ANONYMOUS caller", async () => {
    const missing = await buildTestApp(
      makeService({
        getItem: async () => {
          throw new GalleryItemNotFoundError();
        },
      }).service,
    );
    app = missing.app;
    const gone = await app.inject({ method: "GET", url: "/gallery/nope" });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe("not_found");
    await app.close();

    const { service, seen } = makeService();
    const ok = await buildTestApp(service);
    app = ok.app;
    const res = await app.inject({ method: "GET", url: "/gallery/gal-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.id).toBe("gal-1");
    expect(seen.getViewer).toBeNull();

    // ...and a bad token degrades here too, rather than 401-ing a public item.
    const stale = await app.inject({
      method: "GET",
      url: "/gallery/gal-1",
      headers: BAD_BEARER,
    });
    expect(stale.statusCode).toBe(200);
  });

  it("U-GR7: stream-url is reachable with NO auth header; an unknown item 404s", async () => {
    const { service, seen } = makeService();
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({
      method: "GET",
      url: "/gallery/gal-1/stream-url",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: "https://s3.test/renders/render-1/output.mp4?sig=1",
      expiresAt: EXPIRES.toISOString(),
    });
    // The static-before-parameterised registration order matters: this must NOT have
    // been matched by `/gallery/:id`.
    expect(seen.streamId).toBe("gal-1");
    await app.close();

    const missing = await buildTestApp(
      makeService({
        presignGalleryStream: async () => {
          throw new GalleryItemNotFoundError();
        },
      }).service,
    );
    app = missing.app;
    const gone = await app.inject({
      method: "GET",
      url: "/gallery/nope/stream-url",
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe("not_found");
  });
});

// ------------------------------------------------- POST /renders/:id/gallery (publish)

describe("POST /renders/:id/gallery — publish", () => {
  it("U-GR8: no bearer ⇒ 401, and the service is never called", async () => {
    let called = false;
    const { service } = makeService({
      publish: async () => {
        called = true;
        return { ...ITEM };
      },
    });
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/renders/render-1/gallery",
      payload: PUBLISH_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(called).toBe(false);
  });

  it("U-GR8b: a valid publish ⇒ 201 { item } and the owner id reaches the service", async () => {
    const { service, seen } = makeService();
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/renders/render-1/gallery",
      headers: BEARER,
      payload: PUBLISH_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().item.id).toBe("gal-1");
    expect(seen.publishUser).toBe("u1");
  });

  it("U-GR8c: a malformed body is rejected at the Zod boundary (400) and never reaches the service", async () => {
    let called = false;
    const { service } = makeService({
      publish: async () => {
        called = true;
        return { ...ITEM };
      },
    });
    const built = await buildTestApp(service);
    app = built.app;

    const bad = [
      { ...PUBLISH_BODY, title: "" },
      { ...PUBLISH_BODY, title: "   " },
      { ...PUBLISH_BODY, title: "x".repeat(121) },
      { ...PUBLISH_BODY, scriptureReference: "" },
      { ...PUBLISH_BODY, visibility: "secret" },
      { ...PUBLISH_BODY, translation: "" },
      { title: "only a title" },
    ];
    for (const payload of bad) {
      const res = await app.inject({
        method: "POST",
        url: "/renders/render-1/gallery",
        headers: BEARER,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(called).toBe(false);
  });

  it("U-GR9: the four publish failures map to 404 / 409 / 409 / 422 with distinct `error` strings", async () => {
    const cases: Array<[unknown, number, string]> = [
      [new GalleryItemNotFoundError("render not found"), 404, "not_found"],
      [new RenderNotPublishableError(), 409, "render_not_publishable"],
      [new GalleryItemAlreadyPublishedError(), 409, "already_published"],
      [new ScriptureBookUnderivableError('cannot derive a book from "a poem"'), 422, "scripture_book_underivable"],
    ];

    for (const [error, status, code] of cases) {
      const built = await buildTestApp(
        makeService({
          publish: async () => {
            throw error;
          },
        }).service,
      );
      const res = await built.app.inject({
        method: "POST",
        url: "/renders/render-1/gallery",
        headers: BEARER,
        payload: PUBLISH_BODY,
      });
      expect(res.statusCode, code).toBe(status);
      expect(res.json().error, code).toBe(code);
      // The 422 message must name the offending reference so the client can fix it.
      if (status === 422) expect(res.json().message).toContain("a poem");
      await built.app.close();
    }
  });
});

// -------------------------------------------------------- DELETE /gallery/:id

describe("DELETE /gallery/:id — un-publish", () => {
  it("U-GR10: no bearer ⇒ 401; a foreign/unknown item ⇒ 404; the owner ⇒ 200 { ok: true }", async () => {
    const anon = await buildTestApp(makeService().service);
    app = anon.app;
    const noAuth = await app.inject({ method: "DELETE", url: "/gallery/gal-1" });
    expect(noAuth.statusCode).toBe(401);
    await app.close();

    const foreign = await buildTestApp(
      makeService({
        deleteItem: async () => {
          throw new GalleryItemNotFoundError();
        },
      }).service,
    );
    app = foreign.app;
    const denied = await app.inject({
      method: "DELETE",
      url: "/gallery/gal-1",
      headers: BEARER,
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error).toBe("not_found");
    await app.close();

    const { service, seen } = makeService();
    const owner = await buildTestApp(service);
    app = owner.app;
    const res = await app.inject({
      method: "DELETE",
      url: "/gallery/gal-1",
      headers: BEARER,
    });
    // 200 { ok: true }, matching the DELETE /v1/projects/:id precedent rather than 204.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(seen.deleteUser).toBe("u1");
  });
});

// ------------------------------------------------------ upvotes — row 40 (U-UR1..4)

describe("POST/DELETE /gallery/:id/upvote — row 40", () => {
  it("U-UR1: POST with no bearer ⇒ 401 (row 40's acceptance), and the service is never called", async () => {
    let called = false;
    const { service } = makeService({
      upvote: async () => {
        called = true;
        return { ...ITEM };
      },
    });
    const built = await buildTestApp(service);
    app = built.app;

    const res = await app.inject({ method: "POST", url: "/gallery/gal-1/upvote" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
    expect(called).toBe(false);
  });

  it("U-UR2: DELETE with no bearer ⇒ 401", async () => {
    const built = await buildTestApp(makeService().service);
    app = built.app;
    const res = await app.inject({ method: "DELETE", url: "/gallery/gal-1/upvote" });
    expect(res.statusCode).toBe(401);
  });

  it("U-UR3: a duplicate vote maps to 200 with the current item — NOT 409", async () => {
    // A duplicate vote carries no payload to lose, so it is a no-op, not a state
    // conflict. 409 is the tempting wrong answer, so the status is asserted explicitly.
    const { service, seen } = makeService({
      upvote: async (userId: string) => {
        seen.voteUser = userId;
        return { ...ITEM, upvoteCount: 8, viewerHasUpvoted: true };
      },
    });
    const built = await buildTestApp(service);
    app = built.app;

    for (const _ of [1, 2, 3]) {
      const res = await app.inject({
        method: "POST",
        url: "/gallery/gal-1/upvote",
        headers: BEARER,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().item.upvoteCount).toBe(8);
      expect(res.json().item.viewerHasUpvoted).toBe(true);
    }
    expect(seen.voteUser).toBe("u1");

    const un = await app.inject({
      method: "DELETE",
      url: "/gallery/gal-1/upvote",
      headers: BEARER,
    });
    expect(un.statusCode).toBe(200);
    expect(un.json().item.viewerHasUpvoted).toBe(false);
  });

  it("U-UR4: voting on an unknown item ⇒ 404 not_found, on both verbs", async () => {
    const built = await buildTestApp(
      makeService({
        upvote: async () => {
          throw new GalleryItemNotFoundError();
        },
        removeUpvote: async () => {
          throw new GalleryItemNotFoundError();
        },
      }).service,
    );
    app = built.app;

    for (const method of ["POST", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: "/gallery/nope/upvote",
        headers: BEARER,
      });
      expect(res.statusCode, method).toBe(404);
      expect(res.json().error, method).toBe("not_found");
    }
  });
});

// ------------------------------------------------------------ registration contract

describe("gallery route registration", () => {
  it("U-GR11: every route declares a complete response map, including the error bodies it can actually produce", async () => {
    const built = await buildTestApp(makeService().service);
    app = built.app;

    const expected: Record<string, number[]> = {
      "POST /renders/:id/gallery": [201, 400, 401, 404, 409, 422],
      "GET /gallery": [200, 400],
      "GET /gallery/:id/stream-url": [200, 404],
      "POST /gallery/:id/upvote": [200, 401, 404],
      "DELETE /gallery/:id/upvote": [200, 401, 404],
      "GET /gallery/:id": [200, 404],
      "DELETE /gallery/:id": [200, 401, 404],
    };

    const seen = new Map(
      built.routes.map((r) => [`${r.method} ${r.url}`, r] as const),
    );
    expect([...seen.keys()].sort()).toEqual(Object.keys(expected).sort());

    for (const [key, codes] of Object.entries(expected)) {
      const route = seen.get(key)!;
      const declared = Object.keys(route.response).map(Number).sort((a, b) => a - b);
      expect(declared, key).toEqual([...codes].sort((a, b) => a - b));
      // A declared code with no schema would serialize whatever the handler returned.
      for (const code of codes) {
        expect(route.response[String(code)], `${key} → ${code}`).toBeDefined();
      }
    }
  });

  it("U-GR11b: the auth hook per route is structural — stream-url carries NO auth hook at all", async () => {
    const built = await buildTestApp(makeService().service);
    app = built.app;
    const requireAuth = (app as any).requireAuth;
    const optionalAuth = (app as any).optionalAuth;
    expect(typeof requireAuth).toBe("function");
    expect(typeof optionalAuth).toBe("function");

    const kind = (url: string, method: string) => {
      const r = built.routes.find((x) => x.url === url && x.method === method)!;
      if (r.preHandlers.includes(requireAuth)) return "require";
      if (r.preHandlers.includes(optionalAuth)) return "optional";
      return "none";
    };

    // `none` vs `optional` is invisible behaviourally for a route that never reads
    // req.authUser, which is exactly why this check is structural.
    expect(kind("/gallery/:id/stream-url", "GET")).toBe("none");
    expect(kind("/gallery", "GET")).toBe("optional");
    expect(kind("/gallery/:id", "GET")).toBe("optional");
    expect(kind("/renders/:id/gallery", "POST")).toBe("require");
    expect(kind("/gallery/:id", "DELETE")).toBe("require");
    expect(kind("/gallery/:id/upvote", "POST")).toBe("require");
    expect(kind("/gallery/:id/upvote", "DELETE")).toBe("require");
  });
});
