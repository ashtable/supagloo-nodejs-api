# syntax=docker/dockerfile:1

# Multi-stage build for the Supagloo API (Fastify). Uses node:22-slim (Debian)
# rather than alpine because this image runs Prisma (`prisma migrate deploy` in
# the `migrate` service + building database-lib's client) and Prisma's engines
# are best-supported on glibc. Node 22 matches the monorepo convention.

# ---- deps: build the vendored database-lib, then install API deps ------------
FROM node:22-slim AS deps
WORKDIR /app

# Prisma's engines need libssl present to select the correct openssl-3.0.x
# binary (bookworm-slim omits it); install it before deps so @prisma/engines'
# postinstall detects the right target.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# database-lib ships no dist/ in git (it is gitignored); build it here so the
# file:./supagloo-database-lib dependency resolves to a real compiled client and
# its prisma/ (schema + migrations). npm installs it as a symlink into
# node_modules — the builder and runner stages copy the built submodule so that
# relative symlink (../../supagloo-database-lib) resolves.
COPY supagloo-database-lib/package.json supagloo-database-lib/package-lock.json ./supagloo-database-lib/
RUN npm --prefix supagloo-database-lib ci --no-audit --no-fund
COPY supagloo-database-lib/ ./supagloo-database-lib/
RUN npm --prefix supagloo-database-lib run build

# Install the API's own deps. Resolves the file: db-lib dependency and runs the
# `postinstall` (check-prisma-version) — a Prisma pin drift fails the build here.
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# ---- builder: compile the API TypeScript to dist/ ---------------------------
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/supagloo-database-lib ./supagloo-database-lib
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runner -----------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# libssl for Prisma's schema engine at `prisma migrate deploy` runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# node_modules carries the prisma CLI (used by the `migrate` service) and the
# db-lib symlink; the copied submodule is what that symlink points at (and holds
# the prisma/ schema + migrations `prisma migrate deploy` applies); dist/ is the
# compiled server; prisma.config.ts points the CLI at db-lib's migrations.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/supagloo-database-lib ./supagloo-database-lib
COPY --from=builder /app/dist ./dist
COPY package.json prisma.config.ts ./

EXPOSE 4000
CMD ["node", "dist/server.js"]
