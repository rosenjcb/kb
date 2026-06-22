# Multi-stage build for the kb HTTP + MCP server (Cloud Run friendly).
#
# Runtime model (see docs/deploy-cloud-run.md):
#   - Single container, persistent volume mounted at /data (KB_HOME=/data) so the
#     SQLite index + derived docs survive restarts (no reindex on boot).
#   - First boot builds the index from KB_GIT_REPOS (or rescans a base that already
#     tracks repos); later boots reuse the persisted index.
#   - An in-process scheduler reindexes on a cadence (KB_REINDEX_INTERVAL).

FROM node:24-slim AS builder
ENV HUSKY=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
# scripts/.nvmrc are needed by the `preinstall` hook (check-node-version.mjs).
COPY package.json pnpm-lock.yaml .npmrc .nvmrc ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    HUSKY=0 \
    PORT=8080 \
    KB_HOME=/data
WORKDIR /app
# git is required to clone/pull repos during (re)indexing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data
EXPOSE 8080
# Serves /v1/* and (with --mcp) /mcp. Configure via env: KB_SERVER_API_KEY,
# a provider key (e.g. GEMINI_API_KEY), KB_BASE, KB_GIT_REPOS, KB_REINDEX_INTERVAL.
CMD ["node", "dist/bin/kb.js", "server", "start", "--mcp"]
