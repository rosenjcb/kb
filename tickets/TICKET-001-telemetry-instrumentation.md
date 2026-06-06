# TICKET-001: Telemetry & Trajectory Instrumentation

**Status:** Open  
**Priority:** P0 — Foundational (all other tickets depend on this)  
**Labels:** infrastructure, evaluation

## Context

Every MOEL component needs raw execution data: which tools were called, with what arguments, at what timestamps, and how many tokens were consumed at each step. Without a structured telemetry layer, the trajectory and resource loss functions have nothing to compute against.

This ticket delivers the instrumentation layer that wraps agent tool execution and produces a structured trajectory log for each evaluation run.

## Objective

Implement `TrajectoryTelemetryTracker`, a lightweight class that records per-step tool usage and token consumption, and emits a structured trajectory file at run completion.

## Acceptance Criteria

- [ ] `TrajectoryTelemetryTracker` records `tool_name`, `arguments`, `fresh_tokens`, `cached_tokens`, and `output_tokens` for every agent step.
- [ ] Each step entry includes a `step_index` and elapsed `timestamp` from run start.
- [ ] `compile_trajectory_file()` returns a dict with `task_id`, `condition`, `total_steps`, `elapsed_seconds`, and `trajectory` list.
- [ ] The tracker integrates with the existing eval harness in `eval/` without breaking existing runs.
- [ ] Output is serializable to JSON (no non-serializable types in the trajectory).
- [ ] Unit tests cover: empty trajectory, single step, duplicate tool calls, zero-token steps.

## Implementation Notes

```python
class TrajectoryTelemetryTracker:
    def __init__(self, task_id: str, condition: str): ...
    def record_step(self, tool_name: str, arguments: dict, tokens: dict): ...
    def compile_trajectory_file(self) -> dict: ...
```

The `condition` field must be one of `"N"`, `"K"`, or `"O"` (see PLAN.md).

Token dict keys: `fresh`, `cached`, `output`. Any missing key defaults to `0`.

Consider using OpenInference-compatible span attributes for future observability integration. The tracker should be usable as a context manager so cleanup is guaranteed even on agent crash.

## Output Artifact

`eval/telemetry.py` — tracker implementation  
`eval/runs/<task_id>_<condition>_trajectory.json` — per-run output

## Dependencies

None.

## Feeds Into

TICKET-002, TICKET-003, TICKET-004, TICKET-005, TICKET-009
