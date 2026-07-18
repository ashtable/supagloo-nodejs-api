# supagloo-nodejs-api

Tools for Creators, Built on Gloo AI &amp; YouVersion Platform.

The Supagloo **API**: a Fastify service (auth/session, CRUD, OAuth exchanges,
presigned URLs, job enqueueing). Stateless; scales horizontally. Consumes the
shared `@supagloo/database-lib` (Prisma client, Zod DTO schemas) via a git
submodule + `file:` dependency.

## Stack

- **Fastify 5** + `fastify-type-provider-zod` (request/response DTOs are Zod,
  shared with the Next.js BFF for end-to-end type safety).
- **Zod-validated env loader** (fail-fast at boot).
- **Prisma 7**, pinned to the exact version `@supagloo/database-lib` ships and
  enforced by a `postinstall` check (`check-prisma-version`).
- **CommonJS** + `tsc` build (`node dist/server.js`).

## Development

`@supagloo/database-lib` is vendored as the git submodule `supagloo-database-lib`
and consumed via `"@supagloo/database-lib": "file:./supagloo-database-lib"`. Its
compiled `dist/` is **gitignored**, so you must build the submodule **before**
installing this package's dependencies:

```sh
# 1. Ensure submodules are checked out
git submodule update --init --recursive

# 2. Build database-lib's dist/ (prisma generate + tsc) — required by the file: dep
npm --prefix supagloo-database-lib ci
npm --prefix supagloo-database-lib run build

# 3. Install the API's dependencies (runs the Prisma pin check via postinstall)
npm install
```

### Scripts

| Script            | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `npm run dev`     | Run the server with reload (`tsx watch`).             |
| `npm run build`   | Compile TypeScript to `dist/`.                        |
| `npm start`       | Run the compiled server (`node dist/server.js`).      |
| `npm run typecheck` | Type-check everything (incl. tests) with no emit.   |
| `npm run test`    | Unit tests (`vitest`).                                |
| `npm run test:e2e`| Non-UI e2e: boots the real server over a real socket. |

Requires `DATABASE_URL` (a `postgres://` / `postgresql://` connection string);
see `.env.example`. `PORT` (default `4000`) and `HOST` (default `0.0.0.0`) are
optional.

## Docker

The `Dockerfile` is a multi-stage `node:22-slim` build that builds the db-lib
submodule and compiles the server. The root repo's `docker-compose.yml` runs two
services from this image: a one-shot `migrate` (`prisma migrate deploy`, applying
database-lib's migrations) and the long-running `api` on `:4000`
(`GET /healthz` → `200 {"status":"ok"}`).
