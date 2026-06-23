# kb-slack — Slack Events API bridge to a kb-server instance.
#
# Zero runtime dependencies (node:http + node:crypto + global fetch), so there is no
# install step: just copy the source and run it. Build context is the repo root (see
# packages/kb-server/docker-compose.yml).
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY packages/kb-slack/package.json ./
COPY packages/kb-slack/src ./src
EXPOSE 3000
# Receives Slack webhooks at POST /slack/events; calls KB_SERVER_URL /v1/query.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.mjs"]
