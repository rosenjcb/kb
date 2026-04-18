---
name: kb-dev-workflow
description: >-
  Use the kb CLI during implementation and review: query before big changes,
  submit durable facts, invalidate stale knowledge, validate or dispute
  assumptions, and keep the active KB base aligned. Use when the repo uses KB
  (local-first knowledge) or when the user expects durable project memory.
---

# KB dev workflow (agent skill)

## When to use this skill

Apply on **every non-trivial coding task** in a project that uses the **KB** CLI (or whenever the user has `kb` installed and a base configured). Do not wait for the phrase “update the KB”—treat `kb` as part of the same loop as reading files and running tests.

If `kb` is missing or the user has no base/LLM configured, say so once and continue without pretending you ran commands.

## Prerequisites (check silently)

- **`kb` on PATH** — the human installs it (for example `npm run refresh:global` from the KB repo, or their package’s install path).
- **Base** — `kb use <base>` for this shell session, or `kb use --default <base>` so defaults point at the right session. Named bases live under `~/.kb/sessions/<base>/`.
- **LLM** — `kb` intents need provider credentials in the environment or `~/.kb/config.json` (separate from “no base” errors).

Use `kb use --show` when you are unsure which base is active.

## Core loop (do these in order when relevant)

1. **Discover** — Before large refactors or design choices, run **`kb query "<concise topic>"`** (raise `--limit` if needed). Optionally **`kb docs list --output json`** to see document ids for `--target`.
2. **Record** — After you establish something durable (API contract, invariant, rollout step, ADR-style decision, “why we did X”), run **`kb submit "<one clear fact>"`**. Prefer **`--target <doc-id>`** when the fact belongs in a specific doc; use **`--domain` / `--source`** if the project uses them.
3. **Correct** — If the KB is wrong or superseded, run **`kb invalidate "<old fact>"`**; add a replacement string when you have one. Use **`--preview`** or **`--dry-run`** first if you want to show impact before **`--apply`**.
4. **Challenge** — If a statement might be wrong or contested, run **`kb validate "<fact>"`** or **`kb dispute "<fact>" --because "<evidence from code or docs>"`** instead of arguing only in chat.
5. **Explain** — Use **`kb explain "<change id or fact reference>"`** when the user asks *why* something in the KB says what it says, when that command is available for their version.

Prefer **`--output json`** when you need structured provenance or limits for downstream reasoning; use human output for quick scans.

## Command reference (copy-paste shapes)

### Intent commands

```text
kb submit "<fact>" [--domain ops] [--source runbook] [--target doc-id] [--output human|json]
kb validate "<fact>" [--domain ops] [--output human|json]
kb dispute "<fact>" --because "<counter evidence>" [--domain ops] [--output human|json]
kb query "<topic>" [--limit 5] [--type decision] [--discovery shallow|deep] [--output human|json]
kb explain "<change id|fact>" [--output human|json]
```

### Document browsing

```text
kb docs list [--base <name>] [--limit <n>] [--output human|json]
kb docs view <document-id> [--base <name>]
kb docs view --title "<exact title>" [--base <name>]
```

### Session, config, init, graph, chat

```text
kb use <base>              — active base for this session (~/.kb/config.json activeBase)
kb use --default <base>    — persistent default (selectedBase)
kb use --show
kb default <base>          — alias for default base selection where supported
kb config get
kb config set <key> <value>
kb config unset <key>
kb init [--base <name>] [--non-interactive] [--detach | --resume] [--stop-after <cycle>]
kb graph [--format dot|json] [--entity <name>] [--path <from> <to>]
kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run]
kb publish [options]
kb chat
kb logs list [--command init] [--limit <n>]
```

Run from the **project working directory** unless you pass **`--base`** explicitly on subcommands that support it.

## Quality bar for submits

- One fact per submit when possible; **specific** and **testable** beats vague narrative.
- Cite what you verified (file path, test name, PR) in the fact text when it helps the next reader.
- Do not duplicate a fact that `kb query` already returns at high confidence unless you are refining wording with `invalidate` + `submit`.

## Safety

- Do not pass secrets into `kb submit` / `kb query` strings.
- **`kb invalidate --apply`** mutates stored knowledge—use **`--preview`** when the user should confirm.

## Installation

This skill lives at `skills/kb-dev-workflow/SKILL.md` and is auto-installed to global agent paths (Claude, Cursor, Codex, GitHub) each time `kb` runs. Run `kb skill install` to inject a short reference into the current project's `AGENTS.md` or `CLAUDE.md`.
