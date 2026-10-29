# Multi-stage build for the TiDB Workspace API server.
#
# Stage 1 installs the full dependency set (including native addons such as
# @duckdb/node-api) and runs `npm run build`, which produces dist/api: a
# self-contained runtime root with its own package.json, server sources,
# public/openapi.json and a pruned node_modules holding only the runtime
# dependency closure (mysql2, pg, @duckdb/node-api native binding, jose, ...).
#
# Stage 2 copies only that dist/api tree and runs as a non-root user. The
# Console static assets are built and shipped separately by the website
# pipeline, so they are intentionally NOT part of this image.
#
# Build per architecture (no cross-compilation): the DuckDB binding is a
# native addon resolved for the image's own platform, so amd64 and arm64 are
# built as separate images and joined into a multi-arch manifest by CD.

ARG NODE_VERSION=24.22.1

FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

# Install dependencies first so the layer caches on lockfile changes only.
# The global npm pin mirrors the repository's CI (scripts ignored for the
# pin install only; the project's own install scripts still run on `npm ci`).
# `npm ci` runs the package's preinstall (scripts/check-runtime.mjs), which
# reads package.json and .node-version, so those three plus that one script
# must be present before the install — but nothing else, to keep this layer
# cached on lockfile/runtime changes only.
COPY package.json package-lock.json .node-version ./
COPY scripts/check-runtime.mjs ./scripts/check-runtime.mjs
RUN npm install --global npm@11.6.2 --ignore-scripts \
    && npm ci

# Build the Console (Vite) and the self-contained API bundle (dist/api).
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# dist/api is self-contained (package.json + server + public + runtime-only
# node_modules), so no second install is needed in the runtime image.
COPY --from=builder /app/dist/api ./

# Run as the unprivileged user that the official Node image already provides.
USER node

# The API listens on WORKSPACE_API_PORT (default 4318) and exposes GET
# /api/health. WORKSPACE_DATA_FILE must be set to an absolute path on a
# persistent volume by the deployment; all other runtime configuration and
# every secret (SSO client secret, trusted origins, ...) are injected by the
# environment, never baked into this image.
EXPOSE 4318
CMD ["node", "server/index.mjs"]
