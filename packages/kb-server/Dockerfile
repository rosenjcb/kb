# Multi-stage build for the kb HTTP + MCP server.
#
# Runtime model:
#   - Single container, persistent volume mounted at /data (KB_HOME=/data) so the
#     SQLite index + derived docs survive restarts (no reindex on boot).
#   - First boot builds the index from KB_SERVER_BASE_GIT_REPOS (or rescans a base that already
#     tracks repos); later boots reuse the persisted index.
#   - An in-process scheduler reindexes on a cadence (KB_REINDEX_INTERVAL).

FROM node:24-slim AS builder
ENV HUSKY=0
WORKDIR /app
# Build toolchain for any native deps; pnpm 9 matches CI (no build-scripts gate).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9
# scripts/.nvmrc are needed by the `preinstall` hook (check-node-version.mjs).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc ./
COPY scripts ./scripts
COPY packages/kb-core/package.json packages/kb-core/
COPY packages/kb-client/package.json packages/kb-client/
COPY packages/kb-server/package.json packages/kb-server/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HUSKY=0 \
    PORT=38117 \
    KB_HOME=/data
WORKDIR /app
# git is required to clone/pull repos during (re)indexing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/kb-client/dist ./packages/kb-client/dist
COPY --from=builder /app/packages/kb-server/dist ./packages/kb-server/dist
COPY --from=builder /app/packages/kb-core ./packages/kb-core
COPY --from=builder /app/packages/kb-core/node_modules ./packages/kb-core/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/kb-server/package.json ./packages/kb-server/
COPY packages/kb-client/package.json ./packages/kb-client/
COPY packages/kb-core/package.json ./packages/kb-core/
ENV NODE_PATH=/app/packages/kb-core/node_modules:/app/node_modules
RUN mkdir -p /data
EXPOSE 38117
# Serves /v1/* and (with --with-mcp) /mcp. Configure via env: KB_SERVER_API_KEY,
# a provider key (e.g. GEMINI_API_KEY), KB_SERVER_BASE_NAME, KB_SERVER_BASE_GIT_REPOS,
# KB_REINDEX_INTERVAL.
CMD ["node", "packages/kb-server/dist/bin/kb-server.js", "start", "--with-mcp"]
