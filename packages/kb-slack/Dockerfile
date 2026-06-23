# Build stage: install dependencies and bundle to a single CJS file with esbuild.
# Build context is the repo root (see docker-compose.yml context: ../..),
# so all COPY paths are relative to the repo root.
FROM node:24-slim AS builder
WORKDIR /build
COPY packages/kb-slack/package.json ./
RUN npm install
COPY packages/kb-slack/src ./src
RUN node_modules/.bin/esbuild src/index.ts \
    --bundle \
    --platform=node \
    --target=node24 \
    --format=cjs \
    --outfile=dist/index.js

# Runtime stage: just node and the bundled file — no node_modules needed.
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=builder /build/dist/index.js ./index.js
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.js"]
