# TICKET-010: Evaluation Harness & Condition Environments

**Status:** Open  
**Priority:** P1  
**Labels:** evaluation, harness, infrastructure

## Context

The individual components (loss functions, validators, telemetry) need an orchestrating harness that wires them together and manages the three controlled experimental conditions. This ticket builds the runner that takes a task definition and produces a complete `EvaluationReport` across all three conditions.

The three conditions are:
- **Condition N** — Raw filesystem access (grep, find, direct file reads). No `kb`.
- **Condition K** — Agent has access to `kb`'s semantic index and query tools.
- **Condition O** — Oracle: the minimal required context is injected directly, no exploration.

## Objective

Implement `EvaluationHarness` that runs a task under a specified condition, coordinates all evaluation components, and emits a structured `EvaluationReport`.

## Acceptance Criteria

- [ ] Accepts a `TaskDefinition` with: `task_id`, `description`, `repo_path`, `target_symbols`, `rubric`, `test_command`, `token_budget`, `step_ceiling`.
- [ ] Accepts a `Condition` enum: `N`, `K`, `O`.
- [ ] Runs the agent with the appropriate tool profile for the condition (see Implementation Notes).
- [ ] Collects trajectory via `TrajectoryTelemetryTracker` (TICKET-001).
- [ ] Computes all four loss components and aggregates via `compute_moel` (TICKET-006).
- [ ] Runs manifest validation and mutation check (TICKET-009).
- [ ] Emits `EvaluationReport` with: `task_id`, `condition`, `moel_result`, `manifest_validation`, `mutation_check`, `trajectory_summary`, `raw_trajectory_path`.
- [ ] Reports are written to `eval/reports/<task_id>_<condition>.json`.
- [ ] A `run_all_conditions(task: TaskDefinition) -> dict[str, EvaluationReport]` convenience function runs N, K, O in sequence and returns the comparison.
- [ ] Hard limits enforced: if agent exceeds `step_ceiling` or `token_budget`, run is terminated and losses are set to `1.0` with `terminated: true` in the report.

## Implementation Notes

### Tool Profiles Per Condition

**Condition N** — provide: `read_file`, `list_directory`, `search_file_contents` (grep), `find_files`. No `kb` tools.

**Condition K** — provide all Condition N tools plus: `kb_query_index`, `kb_get_class_skeleton`, `kb_get_documentation_block`. These map to `kb`'s existing query interfaces.

**Condition O** — no exploratory tools. Before the agent starts, inject the minimal context (identified by `target_symbols` + static dependency traversal) directly into the system prompt.

### Oracle Context Injection

For Condition O, use the import graph traversal from TICKET-004 to identify the minimal set of files needed. Read those files and inject their content as a structured context block:

```
<context>
The following files are relevant to this task:
[file: src/db/connection.py]
<content>...</content>
</context>
```

The agent then operates with no tool access — it must produce the answer from injected context alone.

### Agent Interface

The harness should be model-agnostic: it calls the agent via a pluggable `AgentRunner` interface so the underlying model (Claude, GPT, etc.) can be swapped without changing the harness logic.

```python
class AgentRunner(Protocol):
    def run(self, system_prompt: str, user_prompt: str, tools: list[Tool]) -> AgentRun: ...
```

## Output Artifact

`eval/harness.py`  
`eval/conditions.py`  
`eval/reports/` (directory, gitignored by default, included when running experiments)

## Dependencies

TICKET-001, TICKET-006, TICKET-008, TICKET-009

## Feeds Into

TICKET-011, TICKET-012
