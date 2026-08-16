---
"kb-server": minor
---

`kb_query`'s MCP tool now accepts an optional `base` argument that overrides the session's default base for a single call — the same per-call override `/v1/query`'s body `base` already offered over REST. An MCP connection is stateful (one `X-KB-Base` fixed for the whole session at `initialize`), so this is what lets one agent connection reach more than the base it happened to be installed against. Unresolvable slug is an error result (not a 404, MCP has no status codes); a single-base server (no registry) ignores it.
