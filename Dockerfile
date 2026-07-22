# syntax=docker/dockerfile:1

# Multi-stage build for the Supagloo API (Fastify). Uses node:22-slim (Debian)
# rather than alpine because this image runs Prisma (`prisma migrate deploy` in
# the `migrate` service + building database-lib's client) and Prisma's engines
# are best-supported on glibc. Node 22 matches the monorepo convention.

# ---- deps: build the vendored database-lib, then install API deps ------------
FROM node:22-slim AS deps
WORKDIR /app

# Prisma's engines need libssl present to select the correct openssl-3.0.x
# binary (bookworm-slim omits it) so @prisma/engines' postinstall detects the
# right target; git + ca-certificates are needed to clone database-lib below.
# One apt layer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# database-lib is a git submodule of this repo, but we do NOT copy it from the
# build context. Railway (our deploy target) does not initialize git submodules
# and does not copy the outer repo's .git into the Dockerfile build context, so
# `COPY supagloo-database-lib/...` there resolves to an EMPTY directory and the
# build fails on the missing package.json. Instead we clone database-lib from its
# public GitHub URL at build time, pinned to an exact commit so the image is as
# reproducible as the submodule pin (a moving branch like main would silently
# pick up new commits at build time). Keep DATABASE_LIB_REF in lockstep with the
# submodule: whenever a "Bump supagloo-database-lib submodule to <sha>" commit
# lands, update this default to that same SHA in the same commit.
# DO NOT "simplify" this back to a COPY of the submodule dir — it breaks Railway.
ARG DATABASE_LIB_REF=7cc5748662c08bca491199cb76eb0d321a205681
RUN git clone https://github.com/ashtable/supagloo-database-lib.git supagloo-database-lib \
  && git -C supagloo-database-lib checkout "${DATABASE_LIB_REF}" \
  && rm -rf supagloo-database-lib/.git

# database-lib ships no dist/ in git (it is gitignored); build it here so the
# file:./supagloo-database-lib dependency resolves to a real compiled client and
# its prisma/ (schema + migrations). npm installs it as a symlink into
# node_modules — the builder and runner stages copy the built submodule so that
# relative symlink (../../supagloo-database-lib) resolves.
RUN npm --prefix supagloo-database-lib ci --no-audit --no-fund
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
