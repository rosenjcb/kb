---
name: kb-dev-workflow
description: >-
  Use the kb CLI during implementation and review: query before big changes,
  submit durable facts, invalidate stale knowledge, and keep the active KB
  base aligned. Use when the repo uses KB (local-first knowledge) or when the
  user expects durable project memory.
---

# KB dev workflow (agent skill)

## When to use this skill

Apply on **every non-trivial coding task** in a project that uses the **KB** CLI. Do not wait for the phrase “update the KB” — treat `kb` as part of the same loop as reading files, running tests, and updating docs.

If `kb` is missing or the user has no base/LLM configured, say so once and continue without pretending you ran commands.

## Public KB surface

The only supported public KB intents are:

- One read intent: `kb query`
- Two mutation intents: `kb submit` and `kb invalidate`

Do not teach or rely on `kb validate`, `kb explain`, or `kb dispute`.

## Prerequisites (check silently)

- **`kb` on PATH** — for example via `npm run refresh:global` from the KB repo or the installed package path.
- **Base** — `kb use <base>` for the current session, or `kb use --default <base>` for a persistent default. Named bases live under `~/.kb/sessions/<base>/`.
- **LLM** — submit-time graph extraction and any LLM-backed flows need provider credentials in the environment or `~/.kb/config.json`.

Use `kb use --show` when you are unsure which base is active.

## Core loop

1. **Discover** — Before large refactors or design choices, run **`kb query "<concise topic>"`**. Raise `--limit` if needed.
2. **Record** — After you establish something durable, run **`kb submit "<one clear fact>"`**. Use `--domain` / `--source` if the project uses them.
3. **Correct** — If the KB is wrong or superseded, run **`kb invalidate "<old fact>"`**; add a replacement string when you have one.

## Behavioral rules

- `kb query` is the only read intent. Use it for normal lookup and “explain-like” questions.
- `kb submit` writes KB knowledge first, then updates graph state when graph extraction is enabled and meaningful.
- `kb invalidate` updates KB knowledge first, then invalidates the graph provenance tied to the affected KB documents.
- The mutation intents do **not** explicitly target `kb docs` or `kb graph`; those remain the manual inspection/edit surfaces.
- `kb query` uses deep retrieval by default. Pass `--discovery shallow` only when you intentionally want the lighter path.
- Use `--session` only for intentional multi-turn `kb query` flows. Without it, retrieval matches chat behavior and does not rewrite from query-session history.

For human `kb query` output, default orchestration lines are slim (`retrieval>`, `matches>`, `sources>`). Add `--verbose` for `summary>`, `status>`, and `confidence>`. Add `--debug` for one detailed `source>` line per document.

## Command reference

### KB intents

Read intent:

```text
kb query "<topic>" [--base <name>] [--limit 5] [--type decision] [--discovery shallow|deep] [--session] [--verbose] [--debug] [--output human|json]
```

Mutation intents:

```text
kb submit "<fact>" [--base <name>] [--domain ops] [--source runbook] [--include-session-logs] [--output human|json]
kb invalidate "<old-fact>" ["<replacement-fact>"] [--base <name>] [--preview|--dry-run] [--output human|json]
```

### Document browsing

```text
kb docs list [--base <name>] [--limit <n>] [--output human|json]
kb docs view <document-id> [--base <name>]
kb docs view --title "<exact title>" [--base <name>]
```

### Session, config, init, graph, chat

```text
kb use <base>              — active base for this session
kb use --default <base>    — persistent default
kb use --show
kb config get
kb config set <key> <value>
kb config unset <key>
kb init [--base <name>] [--non-interactive] [--detach | --resume] [--stop-after <cycle>]
kb graph [--format dot|json] [--entity <name>] [--path <from> <to>]
kb publish [options]
kb chat [--verbose] [--debug] [--base <name>]
kb logs list [--command init] [--limit <n>]
```

Run from the **project working directory** unless you pass `--base` explicitly.

## Quality bar for submits

- One fact per submit when possible; **specific** and **testable** beats vague narrative.
- Cite what you verified (file path, test name, PR) in the fact text when it helps the next reader.
- Do not duplicate a fact that `kb query` already returns at high confidence unless you are refining or correcting it with `kb invalidate`.

## Safety

- Do not pass secrets into `kb submit` or `kb query`.
- `kb invalidate` mutates stored knowledge by default — use `--preview` or `--dry-run` when the user should confirm impact first.
- Use `ci-*` bases for disposable verification so you do not pollute dogfood knowledge with throwaway experiments.
