---
layout: default
title: ci-eval-20260418-106-compare project overview
date: '2026-04-18 09:17:09'
kb_id: ci-eval-20260418-106-compare-project-overview
tags:
  - overview
  - ci-eval-20260418-106-compare
categories:
  - architecture
---

# ci-eval-20260418-106-compare project overview

Auto-generated from project documentation.

## README.md
# KB

KB is a local-first knowledge system for AI workflows.

It gives you a CLI and runtime that can:
- store durable markdown knowledge,
- query that knowledge through intent commands,
- optionally use SQLite hybrid retrieval (FTS + vector-style ranking) for better search quality as your corpus grows.

## Generalized Use Case

Use KB when you want a repeatable way to capture, validate, dispute, and retrieve project knowledge during development.

Typical flow:
1. Record facts and decisions while you work.
2. Query prior context before making new changes.
3. Keep docs close to code and version them in Git.


## Quick Start

### 1) Install and verify

```bash
pnpm install
pnpm run check
npm run refresh:global
npm run which:kb
```

### 2) Configure `~/.kb/config.json`
Provider is auto-detected from whichever key is present. To set one explicitly:

```bash
kb config set llm.provider openai
```

### 3) Set your KB base

```bash
kb use dogfood            # switch the active base for this session
kb use --default dogfood  # save a persistent default
kb use --show             # show active base and config default
```

Base resolution order (both live in `~/.kb/config.json`):
1. `activeBase` — current working base from `kb use <base>`
2. `selectedBase` — persistent default from `kb use --default <base>` (or `kb default <base>`)

Named bases store their SQLite data under `~/.kb/sessions/<base>/`.

Prerequisites are validated separately: if no base is configured you get a **knowledge base** error; if no LLM credentials/provider are available you get an **LLM** error (never combined as either/or). Canonical copy lives in `src/cli/cli-prerequisites.ts`.

### 4) Start using intent commands

```bash
kb submit "Document writer now supports sqlite index sync"
kb query "sqlite index sync behavior" --limit 5
kb validate "kb use sets the active session base"
kb dispute "kb use should persist across sessions" --because "kb use is session-scoped while kb use --default writes the saved default"
```

## CLI Reference

### Intent commands

```
kb submit "<fact>" [--domain ops] [--source runbook] [--target doc-id] [--output human|json]
kb validate "<fact>" [--domain ops] [--output human|json]
kb dispute "<fact>" --because "<counter evidence>" [--domain ops] [--output human|json]
kb query "<topic>" [--limit 5] [--type decision] [--discovery shallow|deep] [--output human|json]
kb explain "<change id|fact>" [--output human|json]
```

### Document browsing

```
kb docs list [--base <name>] [--limit <n>] [--output human|json]
kb docs view <document-id> [--base <name>]
kb docs view --title "<exact title>" [--base <name>]
```

### Other commands

```
kb use <base>             — switch the active base for the current session
kb use --default <base>   — save persistent default to ~/.kb/config.json
kb use --show             — show active base and config default
kb config get
kb config set <key> <value>
kb config unset <key>
kb init [--base <name>] [--detach | --resume] [--stop-after <cycle>]
kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply]
kb publish [options]
kb chat
```

### Notes

- `kb use <base>` writes `activeBase` to `~/.kb/config.json` so future `kb` commands keep using that base until you switch again.
- `kb use --default <base>` writes `selectedBase` to `~/.kb/config.json`.
- `kb init` defaults to base `default` if `--base` is omitted.
- Typing `kb --help` shows the full help message.

## Optional: SQLite Hybrid Search

Enable when your knowledge corpus grows and lexical search isn't enough.

### 1) Enable native SQLite dependency (if needed)

```bash
pnpm approve-builds --all
pnpm rebuild better-sqlite3
```

### 2) Verify

```bash
kb submit "SQLite hybrid search enabled for this workspace"
kb query "hybrid sqlite retrieval" --limit 5
```

If hybrid retrieval is unavailable or exceeds the latency budget, KB automatically falls back to lexical markdown query.

## Daily Workflow

```bash
kb query "topic"
kb submit "new fact" --target <doc-id>
kb validate "assumption I want to check"
```

## Agent skill: use KB while you develop

Shipped as a real Cursor-style skill (YAML frontmatter + full instructions):

- **Template:** [`examples/agent-skills/kb-dev-workflow/SKILL.md`](examples/agent-skills/kb-dev-workflow/SKILL.md)

**Install (Cursor):** copy that directory into your repo as `.cursor/skills/kb-dev-workflow/` (so the path ends in `.cursor/skills/kb-dev-workflow/SKILL.md`). Other agents: import the same markdown body into whatever “rules” or “skills” format your tool expects.

The skill is self-contained (workflow + full command shapes). The [CLI Reference](#cli-reference) section above stays the in-repo quick reference for humans.

**Roadmap:** We intend to ship a `kb` command (or installer flow) that drops or syncs this skill—and the closest equivalent hooks for each ecosystem—into supported agents automatically (for example Cursor, Claude Code, and other common coding agents), so manual copying is optional rather than required.

## Development Commands

```bash
pnpm run test
pnpm run type-check
pnpm run lint
pnpm run build
```

## Project Map

```text
src/core   — provider abstraction, intent loop, agent loop, runtime types
src/cli    — CLI entrypoint, intent command parsing, base selection, kb init
src/tools  — write/query tools, markdown + sqlite index integration
```


## readme.md
# KB

KB is a local-first knowledge system for AI workflows.

It gives you a CLI and runtime that can:
- store durable markdown knowledge,
- query that knowledge through intent commands,
- optionally use SQLite hybrid retrieval (FTS + vector-style ranking) for better search quality as your corpus grows.

## Generalized Use Case

Use KB when you want a repeatable way to capture, validate, dispute, and retrieve project knowledge during development.

Typical flow:
1. Record facts and decisions while you work.
2. Query prior context before making new changes.
3. Keep docs close to code and version them in Git.


## Quick Start

### 1) Install and verify

```bash
pnpm install
pnpm run check
npm run refresh:global
npm run which:kb
```

### 2) Configure `~/.kb/config.json`
Provider is auto-detected from whichever key is present. To set one explicitly:

```bash
kb config set llm.provider openai
```

### 3) Set your KB base

```bash
kb use dogfood            # switch the active base for this session
kb use --default dogfood  # save a persistent default
kb use --show             # show active base and config default
```

Base resolution order (both live in `~/.kb/config.json`):
1. `activeBase` — current working base from `kb use <base>`
2. `selectedBase` — persistent default from `kb use --default <base>` (or `kb default <base>`)

Named bases store their SQLite data under `~/.kb/sessions/<base>/`.

Prerequisites are validated separately: if no base is configured you get a **knowledge base** error; if no LLM credentials/provider are available you get an **LLM** error (never combined as either/or). Canonical copy lives in `src/cli/cli-prerequisites.ts`.

### 4) Start using intent commands

```bash
kb submit "Document writer now supports sqlite index sync"
kb query "sqlite index sync behavior" --limit 5
kb validate "kb use sets the active session base"
kb dispute "kb use should persist across sessions" --because "kb use is session-scoped while kb use --default writes the saved default"
```

## CLI Reference

### Intent commands

```
kb submit "<fact>" [--domain ops] [--source runbook] [--target doc-id] [--output human|json]
kb validate "<fact>" [--domain ops] [--output human|json]
kb dispute "<fact>" --because "<counter evidence>" [--domain ops] [--output human|json]
kb query "<topic>" [--limit 5] [--type decision] [--discovery shallow|deep] [--output human|json]
kb explain "<change id|fact>" [--output human|json]
```

### Document browsing

```
kb docs list [--base <name>] [--limit <n>] [--output human|json]
kb docs view <document-id> [--base <name>]
kb docs view --title "<exact title>" [--base <name>]
```

### Other commands

```
kb use <base>             — switch the active base for the current session
kb use --default <base>   — save persistent default to ~/.kb/config.json
kb use --show             — show active base and config default
kb config get
kb config set <key> <value>
kb config unset <key>
kb init [--base <name>] [--detach | --resume] [--stop-after <cycle>]
kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply]
kb publish [options]
kb chat
```

### Notes

- `kb use <base>` writes `activeBase` to `~/.kb/config.json` so future `kb` commands keep using that base until you switch again.
- `kb use --default <base>` writes `selectedBase` to `~/.kb/config.json`.
- `kb init` defaults to base `default` if `--base` is omitted.
- Typing `kb --help` shows the full help message.

## Optional: SQLite Hybrid Search

Enable when your knowledge corpus grows and lexical search isn't enough.

### 1) Enable native SQLite dependency (if needed)

```bash
pnpm approve-builds --all
pnpm rebuild better-sqlite3
```

### 2) Verify

```bash
kb submit "SQLite hybrid search enabled for this workspace"
kb query "hybrid sqlite retrieval" --limit 5
```

If hybrid retrieval is unavailable or exceeds the latency budget, KB automatically falls back to lexical markdown query.

## Daily Workflow

```bash
kb query "topic"
kb submit "new fact" --target <doc-id>
kb validate "assumption I want to check"
```

## Agent skill: use KB while you develop

Shipped as a real Cursor-style skill (YAML frontmatter + full instructions):

- **Template:** [`examples/agent-skills/kb-dev-workflow/SKILL.md`](examples/agent-skills/kb-dev-workflow/SKILL.md)

**Install (Cursor):** copy that directory into your repo as `.cursor/skills/kb-dev-workflow/` (so the path ends in `.cursor/skills/kb-dev-workflow/SKILL.md`). Other agents: import the same markdown body into whatever “rules” or “skills” format your tool expects.

The skill is self-contained (workflow + full command shapes). The [CLI Reference](#cli-reference) section above stays the in-repo quick reference for humans.

**Roadmap:** We intend to ship a `kb` command (or installer flow) that drops or syncs this skill—and the closest equivalent hooks for each ecosystem—into supported agents automatically (for example Cursor, Claude Code, and other common coding agents), so manual copying is optional rather than required.

## Development Commands

```bash
pnpm run test
pnpm run type-check
pnpm run lint
pnpm run build
```

## Project Map

```text
src/core   — provider abstraction, intent loop, agent loop, runtime types
src/cli    — CLI entrypoint, intent command parsing, base selection, kb init
src/tools  — write/query tools, markdown + sqlite index integration
```


## AGENTS.md
# AGENTS

Repository-level operating rules for coding agents in this workspace.

## Always-On Dogfood Requirement

For all meaningful development work, agents must document decisions and outcomes in the KB using the CLI.

This is mandatory and does not depend on skill invocation.

## Required Agent Workflow

1. Ensure fresh CLI access before significant work:
   - npm run refresh:global
   - npm run which:kb
2. Use KB docs during execution, not only at the end.
3. Keep test data isolated from persistent docs:
   - Persistent work: use `kb default dogfood` (or pass `--base dogfood` explicitly)
   - Disposable automation: use explicit `--base ci-*` or `--base test-*`
4. Treat persistence as part of completion:
   - git add sessions/
   - git commit -m "kb: checkpoint knowledge base"
   - git push

## Dogfood Interaction Mode (Workspace Default)

For this workspace, dogfood usage defaults to intent-first behavior.

1. Default mode for KB dogfood operations:
   - Use intent commands (`submit`, `validate`, `dispute`, `query`, `explain`) instead of freeform prompts.
2. Update-first policy:
   - Query for related docs first.
   - If a matching doc exists, append/update that doc before creating a new document.
3. Freeform exceptions:
   - Use freeform only when user explicitly requests freeform, or when intent commands cannot express the requested operation.
4. Internal tool boundary remains in effect:
   - Do not directly invoke internal `*_document` tool names from consumer-facing workflows.

Recommended dogfood sequence:
1. `kb query "<topic>" --base dogfood --limit 5 --output json`
2. `kb submit "<new fact or checkpoint>" --base dogfood --target <existing-doc-id>`
3. If no suitable target exists, create a new record via `submit` without `--target`.

## Open-Question Gate (Mandatory)

When a ticket implementation plan contains any unresolved/open question, the agent must explicitly ask the user for a decision before closing the ticket.

Allowed outcomes before closure:

1. User provides a decision and the ticket is updated accordingly.
2. User explicitly approves deferral with a time-box and follow-up ticket reference.

If neither happened, do not mark the ticket closed.

When practical, ask unresolved decisions as multiple-choice prompts:

1. Present 2-5 concrete options.
2. Mark one recommended default.
3. Allow user freeform override.

This is preferred for speed, consistency, and easier agent handoff.

## E2E Validation Requirement

After implementing fundamental changes to the `kb` CLI (new commands, new flags, core loop changes, telemetry, storage changes), always run an end-to-end validation using `kb init` before reporting work complete.

**Default e2e pattern:**
```bash
mkdir -p /tmp/kb-e2e-test && echo "# Test" > /tmp/kb-e2e-test/README.md
cd /tmp/kb-e2e-test && kb init --base ci-e2e-test --non-interactive --debug
```

Use a `--base ci-*` namespace so the test data is disposable and does not pollute dogfood.

For higher-risk changes (storage schema, provider switching, auth), also run interactively (`kb init` without `--non-interactive`) to exercise the full Q&A path.

For lower-risk changes (output formatting, flag parsing, help text), a targeted `kb query "..."` or `kb submit "..."` smoke test is sufficient.

## CLI Fallback

If global kb is unavailable in the environment:

- npm run build:cli
- node dist/bin/kb.js query "What tools are available?"

## Storage Intent

- Dogfood docs are expected to be durable and Git-tracked.
- CI/test namespaces are disposable and should not pollute persistent KB context.

## Enforcement Intent

If a task is completed without KB documentation for significant architectural, behavioral, or process changes, the task should be considered incomplete until KB docs are updated.

## Phase Clarity for SPIKE Tickets (Mandatory)

SPIKE tickets often span multiple phases: **Plan → Code → Validation**. Enforce clarity:

1. **SPIKE (Planning only)** → Ends with Implementation Plan + decision checkpoints. Acceptable for PR if user approves.
2. **SPIKE (Plan + Code)** → Implementation Plan + working code + tests. More complete, ready to merge.

**Requirement**: Implementation Plan MUST explicitly state which phase is "In Scope" and which is "Deferred":

```markdown
#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket/PR
  - Specialized tools design (Option B)
  - Tool conventions codified
  - User decisions finalized
  
- ⏳ Phase 2 (Implementation): Deferred to ticket 048, 049, etc.
  - Implement write_document, append_to_document, etc.
  - Tests + validation
  - **Blocking tickets**: 048 (write_document), 049 (append_to_document), etc.
```

**Enforcement**: If Implementation Plan says code is deferred, create explicit follow-up tickets **before** marking SPIKE closed. Link them in Integration Points.

**User override**: User can explicitly approve "planning-only" SPIKE closure if they accept deferred work.

## Deprecation and Cleanup Policy

When design decisions change or scenarios become obsolete:

1. **Mark clearly**: Use `DEPRECATED` label in section headers or filename prefix.
2. **Provide reason**: Always explain *why* something was deprecated (e.g., "Chosen Option B instead; see ticket 047 for rationale").
3. **Archive strategically**:
   - Small deprecated sections → Keep in original file with `## DEPRECATED` header
   - Large deprecated scenarios → Move to companion `{FILENAME}-DEPRECATED.md` file
   - Entire deprecated tickets → Mark as archived in _index.md with deprecation note
4. **Link forward**: Document what replaced the deprecated approach (new tool, pattern, decision).
5. **Preserve for learning**: Deprecated docs help future agents understand "why not X" and provide context for architectural trade-offs.

**Example:**

```markdown
## DEPRECATED: Scenario D (Option A Design)

This scenario was designed for Option A (unified write_document with operationMode).
It was deprecated in favor of Option B (specialized tools) because [reason].

See [047-DEPRECATED_SCENARIOS.md](047-DEPRECATED_SCENARIOS.md) for archived details.
New implementation uses [merge_documents](src/tools/MergeDocumentsTool.ts) instead.
```

**When to deprecate:**
- Design decisions are reversed or overridden (user approval, new learning)
- Code patterns are replaced with better alternatives
- Specification sections become obsolete due to refactoring
- Tools or approaches are superseded by new tools

Treat deprecation as part of code quality: stale guidance is worse than no guidance.

## Test Conventions

- **Use `dayjs` for all date/time in tests**, never `new Date()`. `dayjs()` is timezone-consistent with the production code. `new Date().toISOString()` returns UTC which can differ from local time and cause flaky file-name assertions (e.g. `YYYY-MM-DD.jsonl` filenames).
- Import `dayjs` from the `dayjs` package (already a project dependency). Use `dayjs().format('YYYY-MM-DD')` instead of `new Date().toISOString().slice(0, 10)`.


## DESIGN.md
# KB TUI Design

## Color Scheme

Portal-inspired (Valve). Blue is primary; orange is secondary.

| Role      | Color     | Usage                                      |
|-----------|-----------|--------------------------------------------|
| Primary   | `#4FC3F7` | Status bar, shell prompt, assistant output |
| Secondary | `#FF7043` | User input, chat you-prompt, base name     |
| Error     | red       | Error messages                             |
| Dim       | gray      | Info lines, separators                     |

## Layout

```
┌─ KB Agent │ base: dogfood │ mode: shell ──────────────────┐  ← StatusBar (blue border)
│                                                            │
│  KB Agent — type a command or /help                       │  ← HistoryPane
│                                                            │
│  kb> query "what is the project?"                         │  ← command (orange)
│  KB is a local-first knowledge system…                    │  ← result (white)
│    Sources: kb-system-overview                            │
│                                                           │
│  kb> chat                                                 │
│  Chat mode — type /exit to return to shell.               │  ← info (gray)
│  you> how does hybrid search work?                        │  ← chat-you (orange)
│  kb> Hybrid search combines BM25 + vector rerank…         │  ← chat-assistant (blue)
│                                                           │
└────────────────────────────────────────────────────────────┘
┌─ kb> ──────────────────────────────────────────────────────┐  ← InputBar (blue border)
└────────────────────────────────────────────────────────────┘
```

In chat mode the InputBar border turns orange and the prompt becomes `you>`.

## TUI vs One-Shot

- `kb` (no args, TTY) → launches TUI
- `kb <command> [args]` → one-shot CLI (non-interactive by default)

## Interactive Commands

| Shell input | Behaviour |
|---|---|
| `query "…"` | Runs intent, shows result inline with spinner |
| `submit "…"` | Submits fact, shows confirmation |
| `chat` | Switches to chat mode |
| `use <base>` | Switches base, StatusBar updates |
| `docs list` | Lists documents |
| `docs view <id>` | Shows document content |
| `/help` | Shows help text |
| `/clear` | Clears history |
| `/exit` | Quits (also Ctrl-C) |
| (in chat) `/exit` | Returns to shell mode |

## Source Structure

```
src/tui/
  index.tsx                 # launchTui(config) — Ink render entry
  App.tsx                   # Root component, state, command dispatch
  runner.ts                 # runCommandForTui(), parseShellArgs()
  theme.ts                  # BLUE, ORANGE constants
  types.ts                  # TuiMode, HistoryEntry, EntryType
  components/
    StatusBar.tsx            # Top bar
    HistoryPane.tsx          # Scrollable output list
    HistoryEntryRow.tsx      # Single output line (type-aware coloring)
    InputBar.tsx             # Bottom prompt + TextInput
    LoadingSpinner.tsx       # ink-spinner wrapper
```


## EVALUATION.md
# KB Evaluation Plan

## Goal

Evaluate whether building and maintaining a `kb` knowledge base is materially useful for real development work, and whether a split workflow works better:

- Agent A builds the product/codebase.
- Agent B maintains and refreshes the knowledge base.

The core hypothesis is that this produces better systems faster, with lower token cost, better requirement capture, and better recall of project knowledge than relying on the primary coding agent's transient context alone.

## Primary Question

After building a KB from scratch for this repository, can `kb` answer important questions about the project accurately and usefully enough to justify the extra maintenance work?

## Secondary Questions

1. Does `kb init` produce a usable knowledge base from the current repo without manual surgery?
2. Does the resulting KB support both retrieval-style questions (`kb query`) and synthesis-style questions (`kb chat`) across multiple topic areas?
3. Is the resulting graph store populated enough to plausibly improve retrieval and follow-up questioning?
4. What is the cost of producing this KB in time, tokens, and operator effort?
5. In a later comparison run, does a dedicated KB-maintenance agent improve outcomes versus a single-agent baseline?

## Evaluation Design

This evaluation should be run at least twice against the same codebase snapshot or equivalent branch state:

1. Baseline run:
   - Build the KB from scratch with the normal workflow.
   - No special second-agent KB-maintenance strategy beyond answering `kb init` questions accurately.
2. Comparison run:
   - Repeat on a fresh disposable base after using the intended two-agent workflow.
   - Keep the question set, scoring rubric, and artifact schema identical.

## Standard Procedure

### Phase 1: Initialize a Fresh KB

From the repo root:

1. Start the TUI with `kb`.
2. Run interactive `/init --base <ci-base-name>`.
3. Let `kb init` complete all passes through `pass-graph`.
4. Save the resulting run metadata and transcript notes.

Use a disposable base name like `ci-eval-YYYYMMDD-<label>` so results do not pollute dogfood data.

### Phase 2: Capture Build Metrics

Collect:

- Base name
- Git branch and commit
- Start/end timestamps
- `kb init` run ID from `kb logs`
- Total init duration
- Total init input tokens
- Total init output tokens
- Estimated init cost
- Number of documents created
- Graph entity count
- Graph relationship count

### Phase 3: Evaluate Answer Quality

Run a fixed question set through both surfaces:

- `kb query "<question>" --base <ci-base> --output json`
- `kb chat` against the same base

Questions should span:

1. Project overview / mission
2. Architecture
3. User workflow / CLI usage
4. Configuration / environment
5. Retrieval / graph / indexing internals
6. Testing / validation
7. Operational caveats / gotchas
8. Recent design decisions or repo-specific conventions

### Phase 4: Score the Results

Each question/surface pair gets a rubric score.

## Canonical Question Set

Use these questions unless there is a strong reason to revise the suite. If revised, copy the old suite forward and record the change in the artifact.

1. What is this project for, and what are the main things `kb` can do?
2. How does `kb init` work at a high level, including the major passes?
3. Where do KB documents live, and how are active/default bases selected?
4. How does retrieval work, including hybrid retrieval and graph involvement?
5. What does `kb chat` do when retrieval is weak or incomplete?
6. What commands should a contributor use during normal dogfood development in this repo?
7. What special repo rules apply to KB documentation and persistence?
8. How can someone inspect the graph and run telemetry/log comparisons?

These questions intentionally mix broad and specific knowledge. A future expansion can add task-oriented prompts like "How do I debug retrieval misses?" or "How do I add a new CLI command safely?"

## Scoring Rubric

Score each answer on four axes from `0` to `4`.

### Correctness

- `4`: Factually correct and grounded in the repo/KB.
- `3`: Mostly correct with minor omissions.
- `2`: Mixed; contains meaningful inaccuracies or unsupported inference.
- `1`: Mostly wrong or misleading.
- `0`: No useful answer.

### Usefulness

- `4`: Directly helps a developer act or understand the system.
- `3`: Helpful but incomplete.
- `2`: Some signal, but requires substantial follow-up.
- `1`: Barely helpful.
- `0`: Not helpful.

### Specificity

- `4`: Uses concrete repo-specific details, commands, or mechanisms.
- `3`: Some concrete detail, but still generic in places.
- `2`: Partly generic.
- `1`: Mostly generic.
- `0`: Purely generic or evasive.

### Evidence Handling

- `4`: Clearly constrained to evidence, acknowledges uncertainty appropriately.
- `3`: Reasonably evidence-grounded.
- `2`: Some speculation or weak grounding.
- `1`: Strong speculation or unsupported claims.
- `0`: No evidence discipline.

## Aggregate Metrics

For each run, compute:

- Mean score per axis for `query`
- Mean score per axis for `chat`
- Combined mean score
- Pass rate where `correctness >= 3` and `usefulness >= 3`
- Coverage notes by topic area

## Success Thresholds

Treat a run as promising if all are true:

1. `kb init` completes successfully on a fresh disposable base.
2. The graph store is populated with non-zero entities and relationships.
3. Combined pass rate is at least `70%`.
4. At least `6/8` questions score `correctness >= 3`.
5. At least `6/8` questions score `usefulness >= 3`.

Treat the two-agent theory as supported only if the comparison run beats the baseline on at least one of:

- Better combined answer quality
- Lower total token cost
- Lower elapsed time
- Better requirement/process capture in qualitative notes

without causing a meaningful regression in the other categories.

## Artifact Format

Store each run as JSON under `evaluation/runs/`.

Recommended filename:

- `evaluation/runs/YYYY-MM-DD-<label>.json`

Each artifact should include:

- Run metadata
- Init metrics
- KB state summary
- Full question set used
- Raw `kb query` outputs
- Raw `kb chat` outputs
- Manual rubric scores
- Aggregate scores
- Qualitative notes

## Required JSON Schema

Future agents should treat the JSON shape below as the canonical artifact format. The goal is repeatability across runs even when the agent does not have prior conversational context.

### Required top-level fields

- `schema_version`
- `evaluation_plan`
- `run_label`
- `status`
- `created_at`
- `repository`
- `hypothesis`
- `run`
- `question_set`
- `query_evaluation`
- `chat_evaluation`
- `aggregate_scores`
- `qualitative_findings`
- `next_improvement_areas`

### Field expectations

- `schema_version`: integer schema version, starting at `1`
- `evaluation_plan`: string path, usually `EVALUATION.md`
- `run_label`: short label like `main-baseline` or `worker-agent-b`
- `status`: `complete` or `partial`
- `created_at`: ISO-8601 timestamp
- `repository`: object with `name`, `branch`, `commit`
- `hypothesis`: short string describing what this run is testing
- `run`: object describing the concrete scenario execution
- `question_set`: ordered array of the exact questions used
- `query_evaluation`: ordered array with one item per question
- `chat_evaluation`: ordered array with one item per question, or an object with `status: "not_captured"` plus `notes` if chat was not captured
- `aggregate_scores`: computed summary metrics
- `qualitative_findings`: flat array of short observations
- `next_improvement_areas`: flat array of likely follow-up improvements

### Required `run` object

The `run` object should contain:

- `base`
- `mode`
- `commands`
- `init_result`

The `init_result` object should contain:

- `status`
- `written_docs`
- `written_doc_ids`
- `init_run_id`
- `init_run_id_note`
- `docs_list`
- `graph_summary`

If a field is unavailable, include it with `null` and explain why in a sibling `*_note` field when appropriate.

### Required per-question shape

Each item in `query_evaluation` and `chat_evaluation` should contain:

- `question_id`
- `question`
- `result_count`
- `retrieval`
- `answer_excerpt`
- `provenance`
- `scores`
- `notes`

The `scores` object must contain:

- `correctness`
- `usefulness`
- `specificity`
- `evidence_handling`

### Raw output capture

To make runs comparable and re-auditable, each per-question object should also include raw command output when practical:

- For query runs: add `raw_query_output`
- For chat runs: add `raw_chat_output`

These may be omitted only if the artifact is marked `partial`.

### Canonical template

```json
{
  "schema_version": 1,
  "evaluation_plan": "EVALUATION.md",
  "run_label": "main-baseline",
  "status": "complete",
  "created_at": "2026-04-17T17:10:00-07:00",
  "repository": {
    "name": "kb",
    "branch": "main",
    "commit": "<git-sha>"
  },
  "hypothesis": "<what this run is testing>",
  "run": {
    "base": "ci-eval-20260417-main-baseline",
    "mode": "interactive_tui_init",
    "commands": [
      "kb",
      "/init --base ci-eval-20260417-main-baseline"
    ],
    "init_result": {
      "status": "accepted",
      "written_docs": 0,
      "written_doc_ids": [],
      "init_run_id": null,
      "init_run_id_note": null,
      "docs_list": {
        "documents": []
      },
      "graph_summary": {
        "entities": 0,
        "relationships": 0
      }
    }
  },
  "question_set": [
    "<question 1>",
    "<question 2>"
  ],
  "query_evaluation": [
    {
      "question_id": 1,
      "question": "<question 1>",
      "result_count": 0,
      "retrieval": {
        "method": null,
        "detail": null,
        "confidence": null
      },
      "answer_excerpt": null,
      "provenance": [],
      "raw_query_output": {},
      "scores": {
        "correctness": 0,
        "usefulness": 0,
        "specificity": 0,
        "evidence_handling": 0
      },
      "notes": ""
    }
  ],
  "chat_evaluation": [
    {
      "question_id": 1,
      "question": "<question 1>",
      "result_count": 0,
      "retrieval": {
        "method": null,
        "detail": null,
        "confidence": null
      },
      "answer_excerpt": null,
      "provenance": [],
      "raw_chat_output": {},
      "scores": {
        "correctness": 0,
        "usefulness": 0,
        "specificity": 0,
        "evidence_handling": 0
      },
      "notes": ""
    }
  ],
  "aggregate_scores": {
    "query": {
      "mean_correctness": 0,
      "mean_usefulness": 0,
      "mean_specificity": 0,
      "mean_evidence_handling": 0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0
    },
    "chat": {
      "mean_correctness": 0,
      "mean_usefulness": 0,
      "mean_specificity": 0,
      "mean_evidence_handling": 0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0
    },
    "combined": {
      "mean_correctness": 0,
      "mean_usefulness": 0,
      "mean_specificity": 0,
      "mean_evidence_handling": 0,
      "pass_rate_correctness_and_usefulness_at_least_3": 0
    }
  },
  "qualitative_findings": [],
  "next_improvement_areas": []
}
```

### Authoring rule

Agents should not invent their own artifact shape for future runs. If the schema needs to change:

1. Update `schema_version`
2. Update this section in `EVALUATION.md`
3. Note the schema change in the artifact itself

## Comparison Guidance

When comparing two runs:

1. Keep the repo state as close as possible.
2. Use fresh `ci-*` bases for both runs.
3. Reuse the same question set and scoring rubric.
4. Prefer the same evaluator, or multiple evaluators with normalized scoring notes.
5. Compare both machine metrics and human judgment.

## Threats to Validity

- Repo familiarity may leak into interview answers and inflate results.
- The evaluator may know the correct answers already.
- LLM/provider drift may change answer quality across days.
- A single run can overfit to a lucky or unlucky `init`.
- Query quality may differ from chat quality; both must be measured separately.

## Current Baseline Execution

The first tracked baseline for this plan is the main-branch run captured in:

- `evaluation/runs/2026-04-17-main-baseline.json`

That artifact should be treated as the reference point for the next comparison run.


