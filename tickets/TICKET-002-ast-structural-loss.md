# TICKET-002: AST Structural Loss (`L_AST`)

**Status:** Open  
**Priority:** P1  
**Labels:** evaluation, correctness

## Context

One half of the correctness loss is structural: does the agent's output have the right syntactic shape? LLM judges are unreliable at catching missing interfaces, wrong function signatures, and malformed class hierarchies. Parsing both the candidate and reference into Abstract Syntax Trees and computing their intersection gives a bias-free, programmatic structural signal.

## Objective

Implement `compute_ast_loss(candidate: str, reference: str, language: str) -> float` using `tree-sitter`. The function returns a normalized loss in `[0, 1]` where `0` means perfect structural match and `1` means no overlap.

## Acceptance Criteria

- [ ] Uses `tree-sitter` to parse both candidate and reference into typed node sets.
- [ ] Node set `N(Y)` captures: class definitions, function signatures, parameter lists, control flow nodes, and variable declarations.
- [ ] Structural distance formula:
  ```
  L_AST = 1 - |N(Y) ∩ N(Y*)| / |N(Y) ∪ N(Y*)|
  ```
  (Jaccard distance over typed node sets.)
- [ ] Returns `1.0` if either input fails to parse (parse failure = maximum loss).
- [ ] Supports at minimum: Python, TypeScript.
- [ ] Unit tests cover: identical inputs → `0.0`, completely different inputs → `1.0`, missing function → partial loss, extra class → partial loss.

## Implementation Notes

Node type granularity matters. Don't just compare node type strings — include the node's name/identifier as part of the key so that renaming a function registers as a difference.

Recommended node key format: `"{node_type}:{identifier}"` (e.g., `"function_definition:compute_loss"`).

For partial files (snippets rather than full modules), wrap in a minimal valid module before parsing to avoid spurious parse errors.

Language grammar packages: `tree-sitter-python`, `tree-sitter-typescript`.

## Output Artifact

`eval/losses/ast_loss.py`

## Dependencies

TICKET-001 (for integrating loss computation into run telemetry)

## Feeds Into

TICKET-006 (MOEL Aggregator)
