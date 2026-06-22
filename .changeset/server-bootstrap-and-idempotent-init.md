---
"kb": minor
---

Make `kb server start` self-bootstrapping and `kb init` idempotent so a server node can be
launched in a fresh container without the manual `kb init` / `kb base` flow.

- `kb server start` now resolves a bootstrap plan (base + git repos + ignore patterns) from,
  in precedence order, `--git`/`--base`/`--branch`/`--bootstrap` flags, env vars
  (`KB_SERVER_BASE_NAME` / `KB_SERVER_BASE_GIT_REPOS`, with `KB_BASE` / `KB_GIT_REPOS` as
  back-compat aliases), or a declarative `kb-server.json` manifest (which can express per-repo
  branches and ignore globs). On an empty volume it boot-builds the index from that plan; on
  a warm volume it reuses the persisted index for fast restarts but folds in any repo newly
  declared in the plan that the base doesn't yet track, so a node converges on its declared
  repo set without manual intervention.
- `kb init` against an already-initialised base no longer re-runs the fresh-init pipeline
  (which clobbered `meta.json` and re-indexed from scratch). It now swaps to the existing base,
  re-syncs its tracked repos, and clones + indexes any newly-listed `--git` remotes, announcing
  the swap clearly in both the TUI and the CLI.
