---
type: "Reference"
title: "Eval Task Definitions"
description: "YAML schema and conventions for the real-issue task definitions loaded by scripts/eval-task.mjs --task."
resource: ./eval/tasks
tags: [eval, tasks, yaml]
timestamp: 2026-08-16T00:15:00Z
---

# Eval task definitions (YAML)

`--task <id>` loads `eval/tasks/<id>.yaml` (or `.yml`). `--task` can also be a path to a YAML
file. Sibling to `eval/suites/*.yaml` (question packs for `eval-run.mjs`), but a task definition
describes one real, end-to-end coding task instead of a fixed question set — see
`TASK_EVALUATION.md` for the full scenario this drives.

Each file needs: `id`, `repo_url`, and one of `issue` (`repo` + `number`, fetched verbatim via
`gh issue view`) or `prompt` (literal task text). Optionally:

- `commit` — pin both arms to this sha. Omit to use the repo's default branch tip at clone
  time (recorded in the artifact either way, so a run is always reproducible after the fact).
- `kb_base` — the kb base slug the kb arm queries against (e.g. `eval-kestra`). Must already be
  indexed; `eval-task.mjs` does not build one.
- `display_name` — human label for logs/summaries.
- `max_turns` — per-arm cap passed to both `claude -p` invocations. Default 30
  (`scripts/eval-task.mjs`'s `DEFAULT_MAX_TURNS`, matching `control-core.mjs`'s control default).

Do not put implementation hints in `prompt` — if the task comes from a real issue, prefer
`issue:` so the agent gets the verbatim ticket text, not a paraphrase. A paraphrased prompt with
added hints steers exploration differently than the real ticket does, which defeats the point of
comparing kb vs no-kb on realistic conditions.

## Example

```yaml
schema_version: 1
id: kestra-18144
display_name: "Kestra #18144 — flow not saved on import"
repo_url: https://github.com/kestra-io/kestra.git
commit: 562ebcb1552d3e6ecda32f7f3df88663c25460c1
kb_base: eval-kestra
issue:
  repo: kestra-io/kestra
  number: 18144
max_turns: 30
```

## Tasks

| Task | Repo | Notes |
|------|------|-------|
| `kestra-18144` | kestra-io/kestra | `[2.0] Flow isn't saved when imported` — UI import path doesn't persist the flow |
