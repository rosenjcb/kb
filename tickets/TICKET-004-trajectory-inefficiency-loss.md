# TICKET-004: Trajectory Inefficiency Loss (`L_trajectory`)

**Status:** Open  
**Priority:** P1  
**Labels:** evaluation, trajectory

## Context

An agent that arrives at a correct answer via 30 redundant file reads is less efficient than one that takes 4 targeted steps. Binary pass/fail cannot distinguish these cases. The trajectory loss penalizes two behaviors: taking more steps than the optimal path, and repeating tool calls (loops, re-reading the same file, re-running the same search).

The optimal path `A_optimal` is derived from static dependency analysis of the repository: given a target symbol or file, what is the minimal set of reads required to understand and modify it?

## Objective

Implement `compute_trajectory_loss(trajectory: list[dict], optimal_actions: list[str], h_limit: int) -> float` that returns a normalized loss in `[0, 1]`.

## Acceptance Criteria

- [ ] Computes step deviation: `|A_actual| / H_limit` clamped to `[0, 1]`.
- [ ] Computes redundancy ratio:
  ```
  R_redundancy = (duplicate tool calls) / max(|A_actual|, 1)
  ```
  where a duplicate is defined as the same `tool_name` + identical `arguments` appearing more than once.
- [ ] Final loss:
  ```
  L_trajectory = 0.5 * (|A_actual| / H_limit) + 0.5 * R_redundancy
  ```
  clamped to `[0, 1]`.
- [ ] If `|A_actual| > H_limit`, the step component is capped at `1.0`.
- [ ] Unit tests cover: optimal path taken → low loss, infinite loop → high loss, single step → near-zero loss, step count at ceiling → step component = 1.
- [ ] A helper `build_optimal_action_set(repo_path: str, target_symbols: list[str]) -> list[str]` uses static import graph traversal to derive `A_optimal` for a given task.

## Implementation Notes

### Optimal Path Derivation

For each task, the evaluator provides a set of target symbols (functions, classes) that the agent must understand to complete the task. The optimal action set is the transitive closure of imports/requires starting from those symbols — i.e., the minimal read frontier.

Use the existing `tree-sitter` infrastructure from TICKET-002 to extract import graphs. For TypeScript: `import` declarations. For Python: `import` and `from ... import` statements.

### Redundancy Detection

Arguments must be normalized before comparison (sort dict keys, strip whitespace) so that superficially different but semantically identical calls are correctly identified as duplicates.

### Step Ceiling

`H_limit` defaults to `20` but should be configurable per task type. Document-generation tasks may have a lower ceiling than refactoring tasks.

## Output Artifact

`eval/losses/trajectory_loss.py`

## Dependencies

TICKET-001 (trajectory data), TICKET-002 (import graph parsing)

## Feeds Into

TICKET-006
