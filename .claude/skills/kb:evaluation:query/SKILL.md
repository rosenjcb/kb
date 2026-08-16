---
name: kb:evaluation:query
description: "Is the user asking me to run a KB query/answer-quality evaluation — the canonical raylib benchmark, the kb dogfood self-check, all/multiple suites (parallel by default), or a custom repo? Should I score kb query results or write evaluation artifacts under ~/.kb/evaluations/ following EVALUATION.md? (Formerly kb:evaluation-run. For full task-execution evals — solving a real GitHub issue with vs without kb — use kb:evaluation:task instead.)"
---

# KB Evaluation: Query

Formerly `kb:evaluation-run`. Use this skill when the user wants a repeatable **query/answer
quality** evaluation run of the `kb` system against a fixed question set. For evaluating whether
kb helps an agent **complete a real coding task** end to end (explore, edit, commit a fix to a
real issue), use the sibling skill `kb:evaluation:task` instead — different scenario, different
artifact shape, see `TASK_EVALUATION.md`.

Canonical spec: `EVALUATION.md`

Do not invent a new scenario or JSON shape. Follow `EVALUATION.md` as the source of truth.

## Embeddings (eval default = Gemini when keyed)

Product default embedder is still local ONNX (`KB_EMBEDDER` unset). **Eval** defaults to
`KB_EMBEDDER=gemini` whenever `GEMINI_API_KEY` is set (init/scan + the shared eval
kb-server), because Darwin often lacks the `onnxruntime-node` native binding and an
index without embeddings aborts. Override with an explicit `KB_EMBEDDER=local` if needed.

## KB 2.0 — do not use removed / pre-2.0 surfaces

Eval must match the **document + symbol** index (hybrid FTS + embeddings). The sentence-level
**fact graph** and the **`kb docs`** CLI are gone.

| Do | Do not |
|----|--------|
| Let `pnpm run eval` harvest metrics | Call `kb docs list` / `docs view` / `docs generate` (removed) |
| Document count = `SELECT COUNT(*) FROM documents` on `~/.kb/sessions/<base>/.kb-index.sqlite` (eval-run already does this into artifact `docs_list.count`) | Invent a `docs list` step or parse old `Count:` CLI text from a live `kb` invocation |
| `kb graph` / `kb graph --entity` = flat **document ↔ symbol** map | Expect triplet / edge-traversal graph dumps (`IMPORTS_FILE`, `EXPORTS_SYMBOL`, relationship walks) |
| Retrieval detail like `hybrid:docs=…,symbols=…,facts=…` | Treat “facts” as the primary indexed unit for 2.0 scoring narratives |
| `pnpm run eval:entities` for ontology kinds | Assume published-snapshot fact totals from older skill tables still describe a fresh 2.0 index |

`scripts/eval-run.mjs` already counts documents via SQLite (not `kb docs list`). If you see
`Unknown command: docs`, the runner or an agent step is still on a pre-2.0 path — fix that; do not
reintroduce the CLI.

Indexing for eval stays on `scripts/eval-index.ts` (`@kb/core` init/scan), not the thin client CLI.

## Preflight — run this before promising a run

Four things have burned agent sessions before. Check them in order; each is one
command and each has a known fix.

**1. Node 24 and installed deps.** The repo pins `engines.node >=24`, but a fresh
container may boot on an older Node with `node_modules` missing. `pnpm` refuses to
run at all on the wrong version (`ERR_PNPM_UNSUPPORTED_ENGINE`).

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 24 && nvm use 24
node -v                       # expect v24.x
pnpm install --frozen-lockfile   # if node_modules/ is absent
pnpm run build                   # eval needs dist/bin/kb + dist/bin/kb-server
```

Every later shell needs the `nvm use 24` prefix — the Bash tool does not persist
shell state between calls.

**2. `flyctl` is installed but not on `PATH`.** It lives at `~/.fly/bin/flyctl`.
A setup script ending in `export PATH=...` cannot help you — that export dies with
the script's own process. Do not conclude it is missing from a bare `command -v`:

```bash
export PATH="$HOME/.fly/bin:$PATH"   # do this in each shell that needs it
flyctl version
```

**3. An LLM provider must actually resolve.** With no key, `kb-server` silently
falls back to `ollama/mistral`, which is not installed — queries then fail at
synthesis rather than at startup. Confirm the resolved provider, don't assume:

```bash
timeout 25 ./packages/kb-server/dist/bin/kb-server start --base eval-kb 2>&1 \
  | grep -o '"provider":"[a-z]*","model":"[^"]*"'
```

`GEMINI_API_KEY` or `OPENAI_API_KEY` covers both `kb query` synthesis and the
`--auto-score` judge. `ANTHROPIC_API_KEY` covers synthesis only.

**4. Check ontology coverage before running anything entity-dependent.** See below —
this is the one most likely to waste an entire run.

## Ontology / index coverage gate (entity / scope / expansion work)

If the change under evaluation touches the entity registry, scope inference, or query
expansion, measure coverage *first* — otherwise the run produces null movement and you
cannot tell "the feature does nothing" from "the data cannot exercise the feature."

For **2.0 indexes**, check documents + symbols + entities (not legacy fact-graph size):

```bash
# Ontology kinds / samples
pnpm run eval:entities -- --suite kb --samples 8
pnpm run eval:entities -- --all-suites

# Structural units (readonly SQLite)
sqlite3 "file:$HOME/.kb/sessions/eval-kb/.kb-index.sqlite?mode=ro" \
  "SELECT 'documents', COUNT(*) FROM documents UNION ALL SELECT 'symbols', COUNT(*) FROM code_symbols UNION ALL SELECT 'entities', COUNT(*) FROM entities;"
```

Historical published-base tables that quoted tens of thousands of **facts** describe the
pre-2.0 sentence graph. Do not use those numbers as a 2.0 success criterion. Re-measure
on the session you are about to score.

Entity-side notes that still matter:

- **`raylib` stays a weak ontology suite** even when document/symbol coverage is rich —
  prefer `kb` / `kestra` when the hypothesis is entity landing or expansion.
- Collision / alias edges (`distinct_from`, etc.) are not a substitute for harvested
  relationship richness — do not treat them as proof the feature is exercised.

## Snapshot credentials — what actually works

`FLY_API_TOKEN` reads bucket keys out of the Fly GraphQL `addOn.environment` field.
**Fly blanks that field for deploy/org tokens** (`fm2_…`), so `snapshot-pull` fails
with "found kb-demo-storage but the environment came back empty — this token cannot
read extension secrets." This is a token *class* problem; it is not fixable by
widening scopes on that token, and retrying with another deploy token gives the same
result. `fly secrets list -a kb-demo` shows only digests, never values.

Working options, in order of preference:

1. **Explicit bucket creds** — `BUCKET_NAME` + `AWS_ACCESS_KEY_ID` +
   `AWS_SECRET_ACCESS_KEY`. Tigris pairs a `tid_…` access key id with a `tsec_…`
   secret; the id alone is not a credential. Bucket is `kb-demo-storage`, endpoint
   `https://t3.storage.dev` (note: `snapshot-pull`'s `DEFAULT_ENDPOINT` is still the
   legacy `fly.storage.tigris.dev`, so set `AWS_ENDPOINT_URL_S3` explicitly).
2. **SSH fallback — pull the adopted indexes off the serving machine.** `kb-demo`
   already holds every base at `/data/sessions/<base>/.kb-index.sqlite`, so no bucket
   access is needed at all:

   ```bash
   export PATH="$HOME/.fly/bin:$PATH"
   flyctl ssh console -a kb-demo -C "sh -c 'ls -lh /data/sessions/*/.kb-index.sqlite'"
   mkdir -p ~/.kb/sessions/eval-raylib && cd ~/.kb/sessions/eval-raylib
   flyctl ssh sftp get /data/sessions/raylib/.kb-index.sqlite -a kb-demo
   ```

   The machine has `node` but no `sqlite3`, so inspect remotely with
   `flyctl ssh console -a kb-demo -C "node -e \"...DatabaseSync...\""` — far cheaper
   than downloading ~800 MB to discover a base is empty.

   These are the *serving* copies, not the sha256-verified snapshot objects. Good
   enough for scoring runs; say so in the artifact rather than implying
   `--from-snapshot` provenance.

## Evaluation target

**Primary external benchmark:** suite `raylib` (repo resolves from suite YAML `repo_url`; optional `--repo` override).

**Kb self-check:** suite `kb` (repo resolves from suite YAML `repo_url`; optional `--repo` override). Different questions from raylib.

**Any other upstream:** suite `generic` + `--repo <git-url>`.

- Default disposable **KB base** = **`eval-{suiteId}`** (e.g. `eval-raylib`); reused across runs. Override with `--base`.
- Indexing uses `scripts/eval-index.ts` (`@kb/core` init/scan) — not the kb client CLI (server-managed for users).
- Snapshot clone cwd = `~/.kb/evaluations/<run-name>/repo/`
- No publish step inside eval-run (artifacts only)
- Artifact: `~/.kb/evaluations/<run-name>/artifact.json` by default

## Grab the Fly snapshot instead of rebuilding (prefer this)

The Fly demo publishes a built, sha256-stamped index per suite repo every day
(`FLY_ORCHESTRATION.md`). Adopting it costs a download; rebuilding the same index
locally costs minutes-to-hours of CPU. **When a current published index is good
enough — most query-side / scoring / regression work — pull it. Only rebuild when
the eval is specifically about indexing, or when the suite needs code newer than
the last daily build.**

```bash
# One-liner: pull the snapshot Fly is serving for the suite, then run the eval on it
pnpm run eval -- --suite raylib --from-snapshot

# Or adopt snapshots first (base eval-<name>), then evaluate however you like
pnpm run snapshot:pull -- --base raylib          # → base eval-raylib
pnpm run snapshot:pull -- --all                  # every base in scripts/fly/bases.json
pnpm run eval -- --suite raylib --skip-scan
```

`--from-snapshot` downloads the immutable version `latest.json` points at, verifies
the manifest sha256, `kb-server import`s it into `eval-<suite>`, and implies
`--skip-scan` — no init, no reindex. It records `command_durations_ms.snapshot_pull`
in the artifact so a snapshot-backed run is distinguishable from a locally built one.

Credentials (one of):
- `BUCKET_NAME` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_ENDPOINT_URL_S3`
  for a non-Tigris store), or
- `FLY_API_TOKEN` — the script reads the bucket keys back from the Fly extension API
  for `--app` (default `kb-demo`).

Useful flags: `--list` (published versions), `--version <v>` (pin one), `--no-import`
(download only), `--into <base>`, `--force` (replace a locally built index),
`--json`. Suite ids and Fly base names are the same strings, so `--suite` and
`--base` are interchangeable here; suites with no published base (e.g. `generic`)
must still be built locally.

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
pnpm run eval -- --all-suites --keep-going     # run every suite even if one fails (default: fast-fail)

# Control baseline (Condition N) runs side-by-side with kb BY DEFAULT.
pnpm run eval -- --suite raylib --skip-control   # opt out → kb-only artifact

# Any git URL → shallow clone → init → generic eight questions
pnpm run eval -- --suite generic --repo https://github.com/org/repo.git

# Conversational chat eval: init + 3 scenarios + retrieval scoring
pnpm run eval:chat -- --base <name> --cwd <repo-path>
```

**Agent rule:** when the user asks for multiple suites (or "all suites"), use `--suites …` or `--all-suites`. Do **not** write OS-specific bash/`xargs` loops — the runner parallelizes in Node. Only pass `--sequential` if the user asks for serial runs.

**Multi-base server:** the multi-suite path shares one long-lived `kb-server` process (PR #172 registry) that stays up for the whole batch — it is never restarted per suite. The batch fast-fails on the first suite failure; pass `--keep-going` to run every suite regardless. Prefer `--skip-scan` when `~/.kb/sessions/eval-*` indexes already exist and the user does not want a rebuild.

Implementation: `scripts/eval-run.mjs` + `scripts/eval-server.mjs`. Repo URL resolves from suite YAML `repo_url`, with `--repo` as explicit override (single-suite only).

Flags: `--suite`, `--suites`, `--all-suites`, `--parallel`, `--sequential`, `--keep-going`, `--skip-scan`, `--skip-control`, `--repo`, `--clone-branch`, `--clone-depth`, `--questions-file`, `--base`, `--run-dir`, `--out`, `--scores-file`, `--auto-score`, `--hypothesis`, `--label`, `--control-agent`, `--control-model`. See `EVALUATION.md` § Automated harvest.

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

In 2.0, **`docs`** is the `documents` table count (SQLite harvest). **`ent` / `rels`** still
come from `kb graph` summary parsing (document↔symbol map counts — not the old triplet
graph). Prefer reading `artifact.json` over re-deriving from removed CLIs.

After every eval run, leave the artifact at `~/.kb/evaluations/<run-name>/artifact.json`. Do **not** copy into the git checkout — trends and `results.tex` already read the home workspace.

## Question sets

Questions are defined in `eval/suites/<suite>.yaml`. Always load from the YAML — never hardcode.

**kb suite** — dogfood questions over the kb repo (setup, scan vs bootstrap, indexing,
query/chat, skills, eval runner, ambiguity / entity-landing probes). Suite answers may
still mention older “import_doc facts” wording; score against what the **running 2.0
code** does (document/symbol index + hybrid retrieval), and flag suite drift rather than
forcing a pre-2.0 narrative.

**raylib suite** — external C codebase benchmark (conceptual + structural). Do not require
AST edge types like `IMPORTS_FILE` / `EXPORTS_SYMBOL` for a valid 2.0 run.

## Index harvest report (after index)

After index/scan (or a full eval), report **what was harvested** — not only query scores:

1. **Documents / symbols** — counts from SQLite (`documents`, `code_symbols`).
2. **Entities** — ontology kinds, counts, and sample names via `eval:entities`.

Session store: `~/.kb/sessions/<base>/.kb-index.sqlite`.

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
