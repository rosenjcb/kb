---
name: kb:evaluation:task
description: "Is the user asking me to run a KB task-execution evaluation — does kb help a real coding agent solve a real GitHub issue faster/cheaper than the same agent with no kb? Should I run scripts/eval-task.mjs against an eval/tasks/<id>.yaml task and write an artifact under ~/.kb/evaluations/ following TASK_EVALUATION.md? (Sibling to kb:evaluation:query, which scores kb query/chat answer quality against a fixed question set — use that one instead if the ask is about answer quality, not task completion.)"
---

# KB Evaluation: Task

Use this skill when the user wants a repeatable, end-to-end comparison of a real coding agent
**solving a real task** (a GitHub issue: explore, edit, commit) with kb available versus without
— not a fixed-question answer-quality check (that's `kb:evaluation:query`).

Canonical spec: `TASK_EVALUATION.md`. Task definitions: `eval/tasks/<id>.yaml`
(`eval/tasks/README.md`). Do not invent a new artifact shape — follow `TASK_EVALUATION.md`.

## Preflight — same four things as kb:evaluation:query, plus two more

Everything in `kb:evaluation:query`'s preflight applies (Node 24, `pnpm run build`, an LLM
provider that actually resolves, ontology coverage if relevant). Two more, specific to this
skill:

**1. `claude` and (if using `--issue`) `gh` must be on PATH.** `scripts/eval-task.mjs` preflights
both and fails fast — before cloning anything — if either is missing. If you see a clone happen
and then a missing-binary error, something bypassed the preflight; fix the runner, don't
work around it.

**2. The target kb base must already be indexed.** `eval-task.mjs` does not build one — point
`--base` / a task's `kb_base` at a base that already exists (`kb base list`), or index it first
with the normal `kb init`/`kb scan` flow (or `pnpm run eval -- --suite <id>` if the target repo
already has a suite YAML — the same base naming convention, `eval-{suiteId}`, applies here too).

## Do not nest this inside your own session

`scripts/eval-task.mjs` spawns `claude -p` as a subprocess. If you (an agent) are asked to "run
the task eval," and you're tempted to invoke it via your own Bash tool: don't, if you're already
running inside a `claude` session yourself. Nesting `claude -p` subprocesses inside an
already-running agent session produced reproducible `aborted_streaming` crashes during this
skill's own development — not a flag/prompt bug, an instability specific to nesting. Tell the
user to run the command directly in their own terminal instead, or use `--dry-run` to hand them
the exact command without executing it yourself.

## Automated runner (single entry)

From kb repo root (`pnpm run build` first):

```bash
# A defined task
pnpm run eval:task -- --task kestra-18144

# Ad hoc (no task YAML) — repo, pinned commit, kb base, and either --issue or --prompt-file
pnpm run eval:task -- --repo https://github.com/org/repo.git --commit <sha> \
  --base eval-org-repo --issue org/repo#123

# See the two claude invocations + resolved prompt without running anything
pnpm run eval:task -- --task kestra-18144 --dry-run

# Iterate on one side only (the other arm's result doesn't change between runs of the same task)
pnpm run eval:task -- --task kestra-18144 --kb-only
pnpm run eval:task -- --task kestra-18144 --control-only
```

Implementation: `scripts/eval-task.mjs`, reusing `scripts/eval-shared.mjs` (artifact root/naming,
token/duration formatting) and `scripts/control-core.mjs` (agent JSON telemetry extraction) —
don't duplicate that logic in a one-off script.

Flags: `--task`, `--repo`, `--commit`, `--clone-branch`, `--base`, `--issue owner/repo#N`,
`--prompt-file`, `--max-turns` (default 30), `--run-dir`, `--out`, `--dry-run`, `--kb-only`,
`--control-only`, `--server-host`/`--server-port`/`--server-api-key`. See `TASK_EVALUATION.md`.

## What gets compared

Two isolated clones, same pinned commit, same verbatim task prompt, same `--max-turns`:

- **Arm K (kb):** kb's MCP tool available, base forced explicitly, `kb:dev-workflow` skill
  content inlined into the system prompt (not relying on the skill being separately installed
  wherever the script runs).
- **Arm N (control):** no MCP, no kb tools/skill, full Read/Grep/Glob/Bash/Edit/Write access
  (unlike `kb:evaluation:query`'s read-only Condition N — this arm has to actually commit a fix).

After both finish, each clone is inspected with `git log`/`git diff` for whether it actually
committed — `committed_diff_stat` when it did, `uncommitted_diff_stat` when it ran out of turns
with real changes still sitting in the working tree (a useful distinction: "found the fix, ran
out of turns before committing" vs. "never found it").

## No correctness judging (know this before quoting a run)

Unlike `kb:evaluation:query`'s 5-axis LLM-judged rubric, this scenario does **not** score whether
a commit is a correct fix — that's unsolved here for arbitrary repos/issues. The artifact
compares cost (turns, cost, duration, tokens) and completion (`committed: true/false`), not
quality. Treat a `committed: true` diff as a lead to review by hand, never as a verified fix in
its own right. Say this explicitly when reporting results — don't let "kb committed a fix,
control didn't" get quoted as "kb produced the correct fix."

## Task definitions (`eval/tasks/<id>.yaml`)

Sibling convention to `eval/suites/*.yaml`. Prefer `issue:` (fetches the real ticket verbatim via
`gh issue view`) over a hand-written `prompt:` — a paraphrased prompt with implementation hints
steers exploration differently than the real ticket does, which defeats the point of the
comparison. See `eval/tasks/README.md` for the schema and `eval/tasks/kestra-18144.yaml` for a
worked example.

## Artifact rule

Same discipline as `kb:evaluation:query`: always write the artifact, even for a partial run
(one arm skipped, or an arm that never committed). Canonical path:
`~/.kb/evaluations/<run-name>/artifact.json` (never an in-repo mirror) — schema in
`TASK_EVALUATION.md`. Leave each arm's clone in place at `<run-dir>/kb-arm/` and
`<run-dir>/control-arm/` after the run; they're not auto-deleted, so the diffs stay inspectable.

## Notes

- `TASK_EVALUATION.md` is singular, same convention as `EVALUATION.md`.
- One task-eval run is one data point on one issue — don't generalize from a single run the way
  you shouldn't generalize from a single `kb:evaluation:query` suite run either.
- If the ask is actually about answer quality on a fixed question set, that's
  `kb:evaluation:query`, not this skill.
