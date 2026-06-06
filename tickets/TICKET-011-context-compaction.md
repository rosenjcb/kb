# TICKET-011: Context Compaction & Runaway Limits

**Status:** Open  
**Priority:** P2  
**Labels:** evaluation, infrastructure, cost-control

## Context

Under Condition N (raw filesystem), agents can spiral into runaway execution: reading large files repeatedly, filling the context window, and then failing because earlier conversation content is truncated. Without guardrails, a single runaway Condition N run can exhaust the token budget for an entire experiment batch.

This ticket adds two protective mechanisms to the harness:
1. **Runaway ceilings** — hard termination when step count or token budget is exceeded.
2. **Context compaction** — automatic summarization of earlier turns when context usage approaches the model's limit.

## Objective

Extend the evaluation harness (TICKET-010) with context compaction and hard termination logic.

## Acceptance Criteria

### Runaway Ceilings
- [ ] If `total_steps > H_limit` (default 20), the run is terminated immediately. The report records `terminated_by: "step_ceiling"`.
- [ ] If `weighted_token_total > B` (default 250,000), the run is terminated immediately. The report records `terminated_by: "token_budget"`.
- [ ] Terminated runs receive `L_trajectory = 1.0` and `L_resource = 1.0` regardless of partial progress. `L_correctness` is computed on whatever partial output the agent produced.
- [ ] Ceiling values are configurable per task in `TaskDefinition`.

### Context Compaction
- [ ] If context usage reaches 95% of the model's context limit, compaction is triggered before the next turn.
- [ ] Compaction strips verbatim file dump content from earlier turns (identified by heuristic: turns where the `read_file` tool returned more than 500 tokens of raw file content).
- [ ] Stripped content is replaced by an LLM-generated one-sentence summary: `"[compacted: read <filename>, contained <summary>]"`.
- [ ] Compaction events are logged in the trajectory with `tool_name: "__compaction__"` and `arguments: {"turns_compacted": int, "tokens_freed": int}`.
- [ ] Compaction is only applied to Condition N runs; Condition K and O runs should not need it (if they do, that is itself a signal worth logging).
- [ ] Unit tests cover: compaction not triggered below 95%, compaction fires at 95%, compaction log entry appears in trajectory, terminated run sets losses correctly.

## Implementation Notes

### Compaction Heuristic

The compaction routine scans backward through conversation history looking for assistant turns that follow a `read_file` tool call. For each such turn where the tool result exceeds the token threshold, it replaces the raw content with a summary.

The summary LLM call should use a minimal, cheap model (haiku-class) to avoid inflating token costs during compaction. The compaction call itself is NOT counted toward the run's token budget (it is overhead, not agent behavior).

### Context Window Tracking

The harness must track the running context size. Since different models have different context limits, the model's context limit must be part of the `AgentRunner` interface:

```python
class AgentRunner(Protocol):
    context_limit: int  # in tokens
    def run(...): ...
```

### Interaction with MOEL

Compaction events do not count as agent steps (they don't increment `step_index`). Token savings from compaction are NOT credited to the agent — the tokens were already counted when they were first generated.

## Output Artifact

`eval/compaction.py`  
`eval/harness.py` (extended)

## Dependencies

TICKET-010

## Feeds Into

TICKET-012
