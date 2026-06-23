# kb-slack

## 0.2.0

### Minor Changes

- Migrate from zero-dependency raw HTTP (.mjs) to @slack/bolt + TypeScript. Bolt's HTTPReceiver
  handles Slack signature verification, URL-verification challenge, fast-ack, and retry
  deduplication automatically, replacing the hand-rolled verify.mjs, slack.mjs, and HTTP server.
  The package now builds with esbuild to a single self-contained CJS bundle; the Dockerfile is a
  multi-stage build (builder → slim runtime, no node_modules needed at runtime).

  Adds direct-message chat mode: messages sent to the bot in a DM open a per-user multi-turn
  /v1/chat session (sessionId: slack-dm-<userId>), preserving conversation history across turns
  on the kb-server (up to 8 turns / 30-minute idle TTL). Channel @kb mentions continue to use
  single-shot /v1/query with an in-thread reply.

  New Slack app scopes required: im:history, im:read (bot token); message.im (event subscription).

## 0.1.0

### Minor Changes

- Initial release: a Slack Events API bot that answers `@kb <question>` mentions by calling a kb-server `POST /v1/query` and posting the synthesized answer (plus sources) back in-thread. Zero runtime dependencies (node:http + node:crypto + fetch); ships a Dockerfile and an optional `kb-slack` compose service (`pnpm run slack:up`). Includes signed-request verification, a 3-second fast-ack with retry de-duplication, and a setup guide.
