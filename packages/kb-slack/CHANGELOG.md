# kb-slack

## 0.2.0

### Minor Changes

- Migrated from zero-dependency raw HTTP (`.mjs`) to `@slack/bolt` + TypeScript. Bolt's
  `HTTPReceiver` now handles Slack signature verification, URL-verification challenge, fast-ack,
  and retry deduplication — replacing `verify.mjs`, `slack.mjs`, and the hand-rolled HTTP server
  in `index.mjs`. The package now builds with esbuild to a single self-contained CJS bundle;
  the Dockerfile is a multi-stage build (builder → slim runtime with no node_modules).

- Added direct-message chat mode: messages sent to the bot in a DM open a multi-turn
  `/v1/chat` session per Slack user (`sessionId: slack-dm-<userId>`), preserving conversation
  history across turns on the kb-server (up to 8 turns / 30-minute idle TTL). Channel `@kb`
  mentions continue to use single-shot `/v1/query` with an in-thread reply.

  New Slack app scopes required: `im:history`, `im:read` (bot token); `message.im` (event subscription).

## 0.1.0

### Minor Changes

- Initial release: a Slack Events API bot that answers `@kb <question>` mentions by calling a kb-server `POST /v1/query` and posting the synthesized answer (plus sources) back in-thread. Zero runtime dependencies (node:http + node:crypto + fetch); ships a Dockerfile and an optional `kb-slack` compose service (`pnpm run slack:up`). Includes signed-request verification, a 3-second fast-ack with retry de-duplication, and a setup guide.
