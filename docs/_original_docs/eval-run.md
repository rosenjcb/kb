---
layout: default
title: EVALUATION.md - Automated harvest (`scripts/eval-run.mjs`)
date: '2026-05-03'
kb_id: evaluation-md-automated-harvest-scripts-eval-run-mjs
tags:
  - source-excerpt
  - evaluation-md
  - kb
categories:
  - reference
---

## Automated harvest (`scripts/eval-run.mjs`).
One runner drives all disposable-base harvests. **No local target directory:** repo URL resolves from suite YAML `repo_url`, with optional `--repo` override. Each run does a **fresh snapshot clone** under `~/.kb/evaluations/<run-name>/repo/`; scratch JSON and the default artifact live under `~/.kb/evaluations/<run-name>/`. **Default `--base`** for `init` / `all` equals **`<run-name>`** (e.g. `raylib-2026-04-27-1303` = repo leaf + date + `HHmm`; same-minute collision adds `-2`, `-3`, …).
From the kb repo root (after `pnpm run build`):
| npm script | Maps to |
|------------|---------|
| `npm run eval:init -- --suite raylib …` | Clone suite `repo_url`, init, queries |
| `npm run eval:init -- --suite kb …` | Clone suite `repo_url`, init, queries |
| `npm run eval:init -- --suite generic --repo <git-url> …` | Generic suite requires explicit repo override, then clone/init/queries |
| `npm run eval:all …` | Same as `eval:init` (alias) |
| `npm run eval:query -- --suite raylib --base <existing> …` | No init: docs + graph + logs + 8× `kb query` (still clones repo for cwd) |
| `npm run eval:gen-doc` | `kb docs generate` smoke (introduction + howto) on `--base` (default `dogfood`); artifact under `~/.kb/evaluations/<run>/` |
**Modes**
- `init` (or legacy `all`) — Fresh clone → `kb init --non-interactive`, then metrics + eight queries.
- `query` — Fresh clone → same capture minus init; requires `--base` for an already-populated KB session.
**Suites (`--suite`)**
- `raylib` — Eight **raylib-specific** questions (this document).
- `kb` — Eight **kb-repo / product** questions (contributor dogfood).
- `generic` — Eight **repo-neutral** questions. Use with `--repo` for arbitrary upstreams.
Override questions with `--questions-file path.json` (JSON array of exactly eight strings) to lock a custom suite without forking the script.
**Example**
```bash
npm run eval:init -- --suite generic \
--repo https://github.com/raysan5/raylib.git \
--label raylib-upstream-smoke \
--auto-score
Options: `--clone-branch main`, `--clone-depth 1` (default shallow; use `0` for full history). The artifact records `run.clone_url`, `run.target_cwd`, `run.run_dir`, `run.run_name`.
**Artifacts**
- Default path: **`~/.kb/evaluations/<run-name>/artifact.json`**. Override with `--out`.
- Rebuild artifact from existing scratch: `--skip-init --run-dir ~/.kb/evaluations/<run-name>/` (expects matching clone at `~/.kb/evaluations/<run-name>/repo/`).
- Automated artifacts may include extra `run` fields for traceability. Tools should treat unknown keys as forward-compatible metadata.
**Docs generate smoke (`scripts/eval-gen-doc.mjs`)**
- Same run root: **`~/.kb/evaluations/<run-name>/`** with `artifact.json` and `gen-doc.log`.
- Flow matches CLI: each scenario runs **`docs generate --finalize`** (draft + `awaiting_review`), optional **`--reject-once "<feedback>"`** (one LLM revision; writes **`diff-introduction.txt`** / **`diff-howto.txt`** when a patch is produced), then **`docs generate --accept`** to commit the SQLite document.
- Each finalized doc is also written as **`export-introduction.md`** and **`export-howto.md`** (SQLite body from `docs view --output json`). Open **`README-exports.md`** in that folder for absolute paths and a one-line `open` / `xdg-open` hint.
- Default **`--base dogfood`**. Optional **`--skip-purge`** to skip deleting prior eval-titled docs (ids derived from fixed `documentTitle` strings).
- Exit `1` only on hard failure; artifact `status` is `complete` when automated checks pass for both scenarios.
- Interactive parity: **`kb chat`** supports **`/docs generate "<prompt>" …`** (questionnaire + review loop) and **`/facts`** (same surface as **`kb facts`**).
