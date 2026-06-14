# kb

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
