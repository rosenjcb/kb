# kb

## 0.7.0

### Minor Changes

- Remove 150-fact cap from kb query. The research loop now runs until all facts are exhausted or a sufficiency threshold is reached, instead of stopping at a hard ceiling.

## 0.6.0

### Minor Changes

- Improve TUI init progress: show repo slug and a bold progress bar above history, with an idle spinner before the first update. Init progress lines now include `@ repo` when indexing multi-repo bases; merge default-branch clone handling from upstream.

## 0.5.0

### Minor Changes

- Multi-repo knowledge bases: a base now tracks one or more git repos and folds them into a single graph.

  - `kb init` requires at least one `--git <url>` (repeatable; supports inline `url#branch` and a `--branch` default). Local-directory init has been removed.
  - Manage a base's repos with `kb config list-repos` / `add-repo <url>` / `remove-repo <url|slug>`.
  - `kb scan` now pulls and re-indexes every repo a base tracks (it no longer reads the working directory); auto-sync syncs all repos.
  - Facts record their originating repo in a new `git_repo` column; a reconciliation pass bridges repos into one connected graph via package-manager, cross-repo symbol, and env/service references.
  - Retrieval is now repo-scoped: query expansion exhausts the landed repo's facts before walking the cross-repo edge tree. The fact-category/tags/topics system (and its Python clustering) has been removed.

## 0.4.1

### Patch Changes

- Fixed eval script using purgd command.

## 0.4.0

### Minor Changes

- dfa8079: Stream model **reasoning ("thinking") tokens as a transient loading bar** during query and chat. Any LLM interaction that opts in via the new `LLMCallParams.onReasoning` callback now enables provider thinking (Anthropic extended thinking, Gemini `includeThoughts`, OpenAI reasoning deltas, Ollama `think`) and surfaces the reasoning live as a self-replacing progress line that disappears the moment the real result arrives — including between iterations of the chat synthesis loop. Reasoning is never written to the permanent transcript. Wired into `kb chat` (TUI + CLI) answer synthesis and the `kb query` answer step; falls back transparently to the existing non-streaming path when a model can't stream reasoning.

## 0.3.0

### Minor Changes

- 2b1d118: Remove non-canonical CLI command aliases and fix the `kb sync` runtime.

  - Drop the duplicate aliases so only the canonical forms exist: `kb use` →
    `kb base use`, `kb default` → `kb base use --default`, `kb view`/`kb list` →
    `kb docs view`/`kb docs list`, and `kb init --rescan` → `kb scan`. The
    `--rescan`/`--apply` flags are no longer parsed from `kb init`.
  - Fix `kb sync` so it resolves and re-indexes git-URL bases correctly at
    runtime (auto-pull and re-index on new commits, no manual scan needed).
  - Refresh the root README and skill docs to reference the canonical commands.

### Patch Changes

- e2bef79: Restore a GitHub release on every push to `main`. Releases are now named after the current Changesets-managed version (e.g. `KB CLI v0.2.0 (build abc1234)`) and include the latest changeset notes from `CHANGELOG.md` in the body. Also fixes the release artifact name mismatch (`node22` → `node24`) that broke the `install-kb.sh` bootstrap installer.

## 0.2.0

### Minor Changes

- 771b16b: Introduce Changesets for semantic versioning. Version is now surfaced in the CLI banner, `--version` flag, TUI welcome screen, and research paper author block (with release date). GitHub Actions enforce a changeset file in every PR and automate version bump PRs and tagged releases on merge to main.
