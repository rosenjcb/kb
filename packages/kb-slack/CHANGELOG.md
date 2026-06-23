# kb-slack

## 0.1.0

### Minor Changes

- Initial release: a Slack Events API bot that answers `@kb <question>` mentions by calling a kb-server `POST /v1/query` and posting the synthesized answer (plus sources) back in-thread. Zero runtime dependencies (node:http + node:crypto + fetch); ships a Dockerfile and an optional `kb-slack` compose service (`pnpm run slack:up`). Includes signed-request verification, a 3-second fast-ack with retry de-duplication, and a setup guide.
