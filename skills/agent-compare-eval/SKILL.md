---
name: agent-compare-eval
description: "Is the user asking me to run an agent token efficiency comparison — measuring whether a KB-backed agent uses fewer tokens than a raw agent across the canonical raylib task sequence?"
---

# Agent Token Efficiency Comparison Eval

Canonical spec: `EVALUATION.md` → **Eval Type 2: Agent Token Efficiency Comparison**

## Purpose

Measure whether a KB-backed agent uses fewer tokens per task than a raw agent, and whether that advantage compounds over a 4-task sequence.

## Which agent am I?

At the start of a new chat the user will specify:

- `--agent raw` → **Agent A**: no `kb` access, discover everything by reading `~/raylib/` source directly
- `--agent kb-backed` → **Agent B**: use `kb query --base raylib` before writing code, `kb submit --base raylib` after each task

If not specified, ask: **"Am I running as Agent A (raw) or Agent B (KB-backed)?"**

Also confirm the **run number** (e.g. `--run 3`). If not specified, inspect `evaluation/runs/agent-compare/` to find the next unused run number for today.

## Canonical task sequence

1. Implement a flappy bird game in `~/raylib/examples/games/flappy_bird.c`
2. Add parallax scrolling background to the flappy bird game
3. Add a high score counter that persists between runs
4. Add sound effects using raylib's audio API

## Per-task protocol (mandatory — do not skip steps)

For **each task**, in order:

```bash
# From kb repo root. (Agent-compare / codeburn only — not `eval:init` / `eval:query`.)

# 1. Snapshot BEFORE
npx tsx scripts/eval-snapshot.ts /tmp/snap-before-t${TASK}.json

# 2. Do the task (code, queries, source reads — whatever is needed)

# 3. Snapshot AFTER
npx tsx scripts/eval-snapshot.ts /tmp/snap-after-t${TASK}.json

# 4. Write artifact + commit (LLM fills --notes and --queries-made)
npx tsx scripts/eval-task-artifact.ts \
  --before  /tmp/snap-before-t${TASK}.json \
  --after   /tmp/snap-after-t${TASK}.json  \
  --task    ${TASK}                        \
  --agent   ${AGENT}                       \
  --run     ${RUN}                         \
  --base    raylib                         \
  --queries-made      ${N_QUERIES}         \
  --submissions-made  ${N_SUBMISSIONS}     \
  --notes   "what you did, what you read, what the KB did or didn't have"
```

**Do not start the next task until the artifact for the current task is committed.**

## Agent A (raw) protocol

- No `kb` access at all — do not run `kb query` or `kb submit`
- Discover context by reading `~/raylib/src/`, headers, and examples directly
- Pass `--base null` (the flag accepts the string `"null"`)

## Agent B (KB-backed) protocol

- Run at least one `kb query --base raylib` before writing any code for the task
- Run at least one `kb submit --base raylib` after completing the task
- May also read source files, but prefer KB for facts already there

## KB base

Use `--base raylib` (permanent, never wiped). The compounding hypothesis requires the same base to accumulate across all sessions and run numbers.

```bash
kb default raylib
```

Never use `ci-*` names for the agent-compare base.

## Artifact location

`evaluation/runs/agent-compare/YYYY-MM-DD-run<N>-task-<N>-<agent>.json`

`scripts/eval-task-artifact.ts` generates the filename automatically from today's date, `--run`, `--task`, and `--agent`.

## Artifact schema

That script builds this from the two snapshots; the operator (or LLM) supplies `--notes`, `--queries-made`, and `--submissions-made`.

```json
{
  "task_id": 1,
  "run": 1,
  "agent": "kb-backed",
  "base": "raylib",
  "kb_queries_made": 2,
  "kb_submissions_made": 1,
  "codeburn_cost_usd_delta": 0.12,
  "codeburn_calls_delta": 8,
  "codeburn_snapshot_before": { "ts": "...", "today_cost": 10.0, "today_calls": 100, "month_cost": 50.0, "month_calls": 500 },
  "codeburn_snapshot_after":  { "ts": "...", "today_cost": 10.12, "today_calls": 108, "month_cost": 50.12, "month_calls": 508 },
  "task_completed": true,
  "notes": "..."
}
```

## End-of-session comparison report

After all 4 tasks are committed, generate a summary across all runs on today's date:

```bash
node -e "
const fs = require('fs'), path = require('path');
const dir = 'evaluation/runs/agent-compare';
const today = new Date().toISOString().slice(0,10);
const files = fs.readdirSync(dir).filter(f => f.startsWith(today));
const rows = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f))));
// group by agent, sum cost and calls
const byAgent = {};
for (const r of rows) {
  byAgent[r.agent] ??= { cost: 0, calls: 0 };
  byAgent[r.agent].cost  += r.codeburn_cost_usd_delta;
  byAgent[r.agent].calls += r.codeburn_calls_delta;
}
console.table(byAgent);
"
```

## Success signal

The KB-backed hypothesis is supported if:
- Agent B's per-task cost is lower than Agent A's by task 3 or 4
- Agent B's cost curve slopes downward across tasks 1–4
- Agent A's cost curve is flat or rising

A single-task win does not confirm the hypothesis — compounding is the signal.
