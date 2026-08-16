---
"@kb/core": patch
"@kb/client": patch
"@kb/server": patch
---

Rename the MCP tool `kb_query` to `query` — the `kb_` prefix was redundant given the server is already registered as `kb` (so the fully-qualified MCP name is `mcp__kb__query`). Updates the tool schema/name, hook matchers and scripts (`kb-reminder.sh`, `kb-feedback.sh`), docs, and tests. Anyone with the hooks already installed should re-run `kb skills install` to pick up the renamed matcher.
