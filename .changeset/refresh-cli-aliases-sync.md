---
"kb": minor
---

Remove non-canonical CLI command aliases and fix the `kb sync` runtime.

- Drop the duplicate aliases so only the canonical forms exist: `kb use` →
  `kb base use`, `kb default` → `kb base use --default`, `kb view`/`kb list` →
  `kb docs view`/`kb docs list`, and `kb init --rescan` → `kb scan`. The
  `--rescan`/`--apply` flags are no longer parsed from `kb init`.
- Fix `kb sync` so it resolves and re-indexes git-URL bases correctly at
  runtime (auto-pull and re-index on new commits, no manual scan needed).
- Refresh the root README and skill docs to reference the canonical commands.
