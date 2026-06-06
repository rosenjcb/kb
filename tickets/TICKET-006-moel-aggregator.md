# TICKET-006: MOEL Aggregator

**Status:** Open  
**Priority:** P1  
**Labels:** evaluation, core

## Context

The three individual loss components (correctness, trajectory, resource) are computed independently. This ticket assembles them into the single `L_MOEL` scalar and produces the canonical per-run result object that the evaluation harness consumes.

```
L_MOEL = w_c · L_correctness + w_t · L_trajectory + w_r · L_resource

where L_correctness = μ · L_AST + (1 - μ) · L_jury
and   w_c + w_t + w_r = 1
```

## Objective

Implement `compute_moel(components: MOELComponents, weights: MOELWeights) -> MOELResult` that validates inputs, enforces weight constraints, and returns a structured result with both the scalar loss and component breakdown.

## Acceptance Criteria

- [ ] Accepts a `MOELComponents` dataclass with fields: `l_ast: float`, `l_jury: float`, `l_trajectory: float`, `l_resource: float`.
- [ ] Accepts a `MOELWeights` dataclass with fields: `w_c: float`, `w_t: float`, `w_r: float`, `mu: float` (AST/jury blend).
- [ ] Validates: all weights in `[0, 1]`, `w_c + w_t + w_r = 1.0` (within float epsilon), `mu` in `[0, 1]`, all loss components in `[0, 1]`.
- [ ] Raises `ValueError` with a descriptive message on any validation failure.
- [ ] Returns `MOELResult` with: `l_moel: float`, `l_correctness: float`, component breakdown dict, weights used.
- [ ] Default weights: `w_c = 0.5, w_t = 0.3, w_r = 0.2, mu = 0.6` (AST-weighted correctness).
- [ ] `MOELResult` serializes to JSON cleanly.
- [ ] Unit tests cover: perfect run → `0.0`, maximum loss → `1.0`, weight validation failures, mu boundary values.

## Implementation Notes

### Weight Defaults

The defaults `w_c = 0.5, w_t = 0.3, w_r = 0.2` reflect that functional correctness is the primary objective, trajectory efficiency is secondary, and raw token cost is a signal but not the primary success criterion. These defaults must be documented and adjustable per experiment.

### Comparison Utility

Include a helper `compare_conditions(results: dict[str, MOELResult]) -> dict` that takes a mapping of condition name → result and returns pairwise differences. The primary comparison is `L_MOEL(K) - L_MOEL(N)`: a negative value confirms the hypothesis that `kb` reduces loss.

### Result Schema

```python
@dataclass
class MOELResult:
    l_moel: float
    l_correctness: float
    l_ast: float
    l_jury: float
    l_trajectory: float
    l_resource: float
    weights: dict
    task_id: str
    condition: str
```

## Output Artifact

`eval/losses/moel.py`

## Dependencies

TICKET-002, TICKET-003, TICKET-004, TICKET-005

## Feeds Into

TICKET-010
