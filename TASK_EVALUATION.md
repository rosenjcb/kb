---
type: "Evaluation Plan"
title: "KB Task-Execution Evaluation Plan"
description: "How KB measures whether it helps a real coding agent complete a real GitHub issue, end to end, versus the same agent with no kb."
resource: ./eval/tasks
tags: [evaluation, methodology, tasks]
timestamp: 2026-08-16T00:15:00Z
---

# KB Task-Execution Evaluation Plan

## Relationship to EVALUATION.md

`EVALUATION.md` measures **answer quality**: `kb query`/`kb chat` against a fixed question set,
judged on a 5-axis rubric, scored kb vs a real no-kb agent control. This document measures a
different thing: does having kb available change how a real coding agent **completes an actual
task** — explores, edits, commits a fix to a real GitHub issue? Same underlying question ("is kb
materially useful for real development work"), different scenario, different artifact shape. Do
not fold this into `EVALUATION.md`'s `query_evaluation`/`chat_evaluation` schema — a task
execution is not a Q&A pair.

Originated as a manual experiment (two isolated `claude -p` sessions, one with kb, one without,
solving the same real issue) before being folded into this repeatable script.

## Goal

Evaluate whether kb reduces the cost (turns, tokens, wall-clock, USD) of a real coding agent
completing a real task, and whether it changes completion itself (did the agent actually commit
a fix within the turn budget).

## Primary Question

Given the same real GitHub issue, the same starting commit, and the same turn budget, does an
agent with kb available (Arm K) commit a correct-looking fix in fewer turns, less time, and lower
cost than the same agent with no kb (Arm N)?

## Scenario

Two fully isolated clones of the target repo, both pinned to the same commit:

```
Arm K (kb):       claude -p, kb's MCP tool available (base explicitly forced), kb:dev-workflow
                   skill content inlined into the system prompt.
Arm N (control):  claude -p, no MCP, no kb tools/skill (--strict-mcp-config, empty mcpServers,
                   --disallowedTools blocks Skill / kb Bash / kb MCP tools) — explores with its
                   own Read/Grep/Glob/Bash, same as EVALUATION.md's Condition N, but with
                   Edit/Write/Bash(git commit) allowed since this is a real coding task, not
                   read-only Q&A.
```

Both arms get:

- The **identical verbatim task prompt** — an issue's title/body fetched via `gh issue view`
  (never a paraphrase — see `eval/tasks/README.md`), or an explicit prompt.
- The same pinned starting commit, on their own throwaway branch so a commit never touches a
  shared ref.
- The same `--max-turns` cap and `--permission-mode bypassPermissions --output-format json`, so
  telemetry is directly comparable and neither arm stalls on a permission prompt.

After both finish (or hit the turn cap), each clone is inspected with `git log`/`git diff` for
whether it actually committed — not just whether it produced text.

## Evaluation Target

Real, individually-defined tasks under `eval/tasks/<id>.yaml` (see `eval/tasks/README.md`), each
naming a real repo, a real (or synthetic) GitHub issue, and a kb base that must already be
indexed for that repo. This is deliberately **not** a fixed benchmark suite the way
`EVALUATION.md`'s raylib/kb/kestra question packs are — a task is a single concrete scenario, and
new ones are added as new tasks are worth measuring, not as a growing fixed battery run every
time.

## Automated runner (`scripts/eval-task.mjs`)

```bash
# From a defined task
pnpm run eval:task -- --task kestra-18144

# Ad hoc, no task file
pnpm run eval:task -- --repo https://github.com/org/repo.git --commit <sha> \
  --base eval-org-repo --issue org/repo#123

# Print the two claude invocations and the resolved prompt without running anything
pnpm run eval:task -- --task kestra-18144 --dry-run

# Only one arm (e.g. re-running after tuning the kb-side prompt)
pnpm run eval:task -- --task kestra-18144 --kb-only
pnpm run eval:task -- --task kestra-18144 --control-only
```

Flags: `--task`, `--repo`, `--commit`, `--clone-branch`, `--base`, `--issue owner/repo#N`,
`--prompt-file`, `--max-turns` (default 30), `--run-dir`, `--out`, `--dry-run`, `--kb-only`,
`--control-only`, `--server-host`/`--server-port`/`--server-api-key` (default
`127.0.0.1:38117`, matching `scripts/eval-server.mjs`'s `DEFAULT_KB_SERVER_PORT`).

**Preflight.** The runner fails fast — before cloning anything — if `claude` is not on PATH, if
`gh` is required (an `--issue`/`issue:` task) and missing, or if the kb arm is enabled and the kb
server isn't healthy for the requested base. It never does clone/checkout work only to discover
the agent or the KB base is missing.

**Nesting warning.** Run this script directly in your own terminal, not from inside another
Claude Code session's Bash tool. Nesting `claude -p` subprocesses inside an already-running agent
session has produced reproducible `aborted_streaming` crashes during this feature's own
development — not a flag or prompt problem, an instability specific to the nested-subprocess
case.

## Artifact Storage

Same root as `EVALUATION.md`: **`~/.kb/evaluations/<run-name>/artifact.json`**, override with
`--out`. `<run-name>` is allocated the same way `eval-run.mjs` does (`eval-shared.mjs`'s
`allocateRunName`), so task and query-eval runs interleave chronologically under one directory.
Each run's two clones live alongside it at `<run-dir>/kb-arm/` and `<run-dir>/control-arm/` —
left in place after the run (inspect the diff/commit yourself; not auto-deleted).

## Required JSON Schema

`schema_version: 1`. Do not invent a different shape — if it needs to change, bump
`schema_version` and update this section, per `EVALUATION.md`'s authoring rule.

```json
{
  "schema_version": 1,
  "evaluation_plan": "TASK_EVALUATION.md",
  "run_label": "kestra-18144-2026-08-16-0100",
  "status": "complete",
  "created_at": "2026-08-16T01:00:00.000Z",
  "task": {
    "id": "kestra-18144",
    "repo_url": "https://github.com/kestra-io/kestra.git",
    "commit": "562ebcb1552d3e6ecda32f7f3df88663c25460c1",
    "kb_base": "eval-kestra",
    "issue": { "repo": "kestra-io/kestra", "number": "18144" },
    "prompt": "Fix this GitHub issue in the repo. Here is the issue verbatim: …",
    "max_turns": 30
  },
  "arms": {
    "kb": {
      "committed": true,
      "head_commit": "<sha>",
      "committed_diff_stat": " ui/src/components/flows/FlowCreate.vue | 7 +++++++\n 1 file changed, 7 insertions(+)",
      "uncommitted_diff_stat": null,
      "telemetry": {
        "input_tokens": 0,
        "output_tokens": 8895,
        "cache_read_tokens": 2149498,
        "total_cost_usd": 1.2497,
        "num_turns": 31,
        "duration_ms": 183877,
        "session_id": "…",
        "is_error": false
      },
      "wall_ms": 184210
    },
    "control": {
      "committed": false,
      "head_commit": "<sha, unchanged from pinned commit>",
      "committed_diff_stat": null,
      "uncommitted_diff_stat": " ui/src/components/flows/FlowCreate.vue | 6 ++++++\n 1 file changed, 6 insertions(+)",
      "telemetry": {
        "input_tokens": 0,
        "output_tokens": 19897,
        "cache_read_tokens": 2153251,
        "total_cost_usd": 1.9253,
        "num_turns": 31,
        "duration_ms": 254590,
        "session_id": "…",
        "is_error": false
      },
      "wall_ms": 254900
    }
  },
  "comparison": {
    "committed": { "kb": true, "control": false },
    "num_turns": { "kb": 31, "control": 31, "delta_kb_minus_control": 0 },
    "total_cost_usd": { "kb": 1.2497, "control": 1.9253, "delta_kb_minus_control": -0.6756 },
    "duration_ms": { "kb": 183877, "control": 254590, "delta_kb_minus_control": -70713 },
    "output_tokens": { "kb": 8895, "control": 19897, "delta_kb_minus_control": -11002 }
  }
}
```

`arms.kb`/`arms.control` are `null` when that arm was skipped (`--kb-only`/`--control-only`);
`comparison` is `null` unless both ran. `committed_diff_stat` is set only when the arm actually
committed past the pinned commit; `uncommitted_diff_stat` captures working-tree changes left
behind when the arm ran out of turns before committing (a `git diff --stat`, no commit needed to
populate it) — useful for telling "found the fix, ran out of turns before committing" apart from
"never found it."

## Known Limitations

- **No correctness judging.** Unlike `EVALUATION.md`'s LLM-judged rubric, this scenario does not
  score whether a commit is an actually-correct fix — generically judging "is this diff a correct
  fix for this issue" is unsolved here. `comparison` measures cost and completion (committed
  y/n), not quality. Treat a `committed: true` diff as a lead to review by hand, not a verified
  fix. A quality axis is plausible future work (e.g. re-running the target repo's own test suite
  against each arm's commit, when one exists) but is out of scope for schema v1.
- **`evidence` label calibration is out of scope here.** Whether the kb arm's answers were
  well-grounded is a `kb query` concern (see `EVALUATION.md`'s judged `evidence_handling` axis);
  this scenario only sees the agent's end state (committed or not, cost), not per-turn kb_query
  groundedness.
- **One task, one run, small n.** A single task-eval run is one data point on one issue. Treat
  conclusions the way `EVALUATION.md` treats a single suite run — comparable within the same
  artifact, not a substitute for running several tasks before generalizing.

## Comparison Guidance

**Primary comparison:** kb vs control within the **same** artifact
(`comparison.*.delta_kb_minus_control`), matching `EVALUATION.md`'s convention — never compare a
kb-arm run from one artifact against a control-arm run from a different one.

When re-running a task for a kb-side change (e.g. after a retrieval-ranking fix):

1. Keep the task pinned to the same `commit` so both runs face identical starting state.
2. Prefer `--kb-only` for kb-side iteration once you already have a control baseline for that
   task — the control arm doesn't change between runs of the same task.
3. Re-run the control arm periodically to catch drift (model updates, provider changes) rather
   than assuming an old control run stays valid indefinitely.
