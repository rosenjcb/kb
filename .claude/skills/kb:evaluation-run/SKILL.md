---
name: kb:evaluation-run
description: "Is the user asking me to run a KB evaluation — the canonical raylib benchmark, the kb dogfood self-check, all/multiple suites (parallel by default), or a custom repo? Should I score kb query results or write evaluation artifacts under ~/.kb/evaluations/ following EVALUATION.md?"
---

# KB Evaluation Run

Use this skill when the user wants a repeatable evaluation run of the `kb` system.

Canonical spec: `EVALUATION.md`

Do not invent a new scenario or JSON shape. Follow `EVALUATION.md` as the source of truth.

## Evaluation target

**Primary external benchmark:** suite `raylib` (repo resolves from suite YAML `repo_url`; optional `--repo` override).

**Kb self-check:** suite `kb` (repo resolves from suite YAML `repo_url`; optional `--repo` override). Different questions from raylib.

**Any other upstream:** suite `generic` + `--repo <git-url>`.

- Default disposable **KB base** = **`eval-{suiteId}`** (e.g. `eval-raylib`); reused across runs. Override with `--base`.
- Indexing uses `scripts/eval-index.ts` (`@kb/core` init/scan) — not the kb client CLI (server-managed for users).
- Snapshot clone cwd = `~/.kb/evaluations/<run-name>/repo/`
- No publish step inside eval-run (artifacts only)
- Artifact: `~/.kb/evaluations/<run-name>/artifact.json` by default

## Automated runner (single entry)

From kb repo root (`pnpm run build` first):

```bash
# Canonical raylib run: clone → init → queries + auto-score (on by default)
pnpm run eval -- --suite raylib

# Kb repo dogfood questions
pnpm run eval -- --suite kb

# Multi-suite — Node-native, **parallel by default** (no bash/xargs).
# Parent starts ONE shared multi-base kb-server; each child attaches and selects
# eval-{suite} via --base / X-KB-Base (probes /healthz?base=).
pnpm run eval -- --suites raylib,kb,fzf
pnpm run eval -- --all-suites --control-agent cursor --control-model composer-2.5
pnpm run eval -- --all-suites --skip-control --skip-scan   # reuse indexes, kb-only
pnpm run eval -- --all-suites --sequential     # one at a time
pnpm run eval -- --all-suites --parallel 4     # cap concurrency
pnpm run eval -- --all-suites --per-suite-server  # legacy: one kb-server per suite

# Control baseline (Condition N) runs side-by-side with kb BY DEFAULT.
pnpm run eval -- --suite raylib --skip-control   # opt out → kb-only artifact

# Any git URL → shallow clone → init → generic eight questions
pnpm run eval -- --suite generic --repo https://github.com/org/repo.git

# Conversational chat eval: init + 3 scenarios + retrieval scoring
pnpm run eval:chat -- --base <name> --cwd <repo-path>
```

**Agent rule:** when the user asks for multiple suites (or "all suites"), use `--suites …` or `--all-suites`. Do **not** write OS-specific bash/`xargs` loops — the runner parallelizes in Node. Only pass `--sequential` if the user asks for serial runs.

**Multi-base server:** default multi-suite path shares one `kb-server` process (PR #172 registry). Do **not** restart a server per suite unless the user asks for `--per-suite-server`. Prefer `--skip-scan` when `~/.kb/sessions/eval-*` indexes already exist and the user does not want a rebuild.

Implementation: `scripts/eval-run.mjs` + `scripts/eval-server.mjs`. Repo URL resolves from suite YAML `repo_url`, with `--repo` as explicit override (single-suite only).

Flags: `--suite`, `--suites`, `--all-suites`, `--parallel`, `--sequential`, `--per-suite-server`, `--skip-scan`, `--skip-control`, `--repo`, `--clone-branch`, `--clone-depth`, `--questions-file`, `--base`, `--run-dir`, `--out`, `--scores-file`, `--auto-score`, `--hypothesis`, `--label`, `--control-agent`, `--control-model`. See `EVALUATION.md` § Automated harvest.

Artifacts default under `~/.kb/evaluations/<run-name>/`.

## Control baseline (Condition N) — `scripts/control-core.mjs`, a phase of `eval`

The control is the workflow kb is measured against: a **real coding agent (Claude Code headless), no kb**, answering
the same suite questions by exploring the clone itself. It runs **by default inside `pnpm run eval`** (not a separate
command) — pass `--skip-control` to opt out. It scores with the **same rubric/judge** as `kb query`. The single
`artifact.json` holds kb at top level (`run.condition = "kb"`), a `control` block (its own `aggregate_scores` +
`control_telemetry` tokens/turns/cost), and a `comparison` block (kb-minus-control deltas); with `--skip-control` those
keys are absent. The agent runs with `--bare --strict-mcp-config` so no MCP/kb tools load. Knobs: `--control-model`,
`--control-max-turns`, `--control-prompt` (`KB_CONTROL_PROMPT`, must contain `{{question}}`), `--control-agent-cmd`
(`KB_CONTROL_AGENT_CMD`, e.g. Cursor). The trends summary separates control-vs-kb rows and prints deltas. See
`EVALUATION.md` § The Control.

## Headline grade: kb vs control (ΔS)

The project verdict is **`artifact.comparison.success_score.delta_kb_minus_control`** from a single eval run with both phases:

```bash
pnpm run eval -- --suite kb --auto-score    # → ΔS in artifact + end summary
```

| ΔS | Verdict |
|----|---------|
| ≥ +0.02 | kb ahead of control |
| ≤ −0.02 | kb behind control |
| else | on par |

`--skip-control` omits `control`/`comparison` — use only for kb-side iteration; no ΔS.

Full spec: `EVALUATION.md` § Headline verdict.

## Secondary: trends summary (regression tracking)

Every `pnpm run eval` run **ends with an automatic trends summary** listing prior runs
for the suite (structural metrics + score columns) — there is no separate `eval:trends`
script. Use that summary to spot kb-side regressions — **not** as the headline
kb-vs-control comparison (that requires ΔS from one artifact).

Columns: `date | run | docs | ent | rels | res | success | pass | corr | use`

After every eval run, leave the artifact at `~/.kb/evaluations/<run-name>/artifact.json`. Do **not** copy into the git checkout — trends and `results.tex` already read the home workspace.

## Question sets

Questions are defined in `eval/suites/<suite>.yaml`. The kb and raylib suites include a mix of conceptual and code-structure questions:

**kb suite** — includes questions that specifically test code-graph traversal (IMPORTS_FILE, EXPORTS_SYMBOL edges) e.g. "Which source files import TsMorphIndexer?" These require the `code-graph` cycle to have run and the semantic bridge to be populated.

**raylib suite** — includes structural questions about module dependencies and file relationships that test what the semantic graph captured about the C codebase.

Do not hardcode question text in prompts or scripts — always load from the YAML.

## Entity harvest report (after index)

After index/scan (or a full eval), report **what entities were harvested** — ontology kinds, counts, and sample names — not only query scores. The session store is `~/.kb/sessions/<base>/.kb-index.sqlite` (`entities` / `entity_aliases`).

```bash
# One base or suite (base = eval-{suiteId})
pnpm run eval:entities -- --base eval-kb
pnpm run eval:entities -- --suite kb --samples 8

# Every suite id under eval/suites/*.yaml
pnpm run eval:entities -- --all-suites
pnpm run eval:entities -- --list-suites
pnpm run eval:entities -- --suite raylib --json
```

Implementation: `scripts/eval-entities.mjs` (`pnpm run eval:entities`). Human table on stdout by default; `--json` for machine output.

**Harvest-only mode** (reindex all suites, no query/control): another agent or you run init/scan via `scripts/eval-index.ts` (or `pnpm run eval` scan path). Then dump entities — do **not** require a full query+control eval-run. There is no `--skip-query` on `eval-run`; use the dedicated script:

```bash
# After indexes exist under ~/.kb/sessions/eval-*
pnpm run eval:entities -- --all-suites
# Or after scanning one base:
pnpm exec tsx scripts/eval-index.ts scan --base eval-kb
pnpm run eval:entities -- --suite kb
```

## Auto-scoring

`--auto-score` needs `GEMINI_API_KEY` or `OPENAI_API_KEY`. The judge picks a descriptive **label** per axis (e.g. `mostly_correct`), each mapping to an ordinal `0–4` level. Or `--scores-file` with eight `{ correctness, usefulness, relevance, specificity, evidence_handling, notes }` objects — each axis a rubric label or an equivalent raw `0–4` level per `EVALUATION.md`.

## Artifact rule

Always write the artifact, even for weak or partial runs.

- Everything captured → `status: "complete"`
- Something missed → `status: "partial"`
- Canonical artifact path: `~/.kb/evaluations/<run-name>/artifact.json` (never an in-repo `evaluation/` mirror)

## JSON rule

Use the schema in `EVALUATION.md`. Minimum:

1. Keep the exact top-level structure.
2. Keep the same question ordering (per suite).
3. Include raw outputs when practical.
4. If a field is unavailable, use `null` and explain why in a sibling `*_note` field.

## Publish

Not part of eval-run. Keep eval artifacts only; publish flows run separately.

## Output paths

- Spec: `EVALUATION.md`
- Artifacts: `~/.kb/evaluations/<run-name>/artifact.json` (see `EVALUATION.md` § Artifact Storage)
- Paper export: `research/tables/results.tex` (from home-dir artifacts)

## Notes

- `EVALUATION.md` is singular. If the user says `EVALUATIONS.md`, treat it as `EVALUATION.md`.
- Keep `ci-raylib-*` / disposable bases ephemeral; never pollute `dogfood`.
- A low score is a valid result — comparability over optics.
- Prefer the latest scored raylib artifact under `~/.kb/evaluations/` over any retired in-repo baseline path.
