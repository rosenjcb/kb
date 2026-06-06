# TICKET-009: Programmatic Validation (Manifest & Mutation Checks)

**Status:** Open  
**Priority:** P1  
**Labels:** evaluation, validation, testing

## Context

LLM jury scores are probabilistic. Programmatic checks that don't rely on model judgment provide a hard, contamination-resistant correctness floor. Two checks are specified in the research plan:

1. **Manifest Check** — the agent must declare every file it touched. The harness verifies the declaration matches the actual git diff.
2. **Mutation Check** — agent-modified code must pass the test suite against the real repo, and fail the test suite when targeted code dependencies are stubbed to no-ops. This confirms that tests are active and linked to the agent's changes, not just coincidentally passing.

## Objective

Implement `ManifestValidator` and `MutationValidator` as standalone harness components that produce pass/fail signals feeding into the overall evaluation.

## Acceptance Criteria

### Manifest Check
- [ ] Agent is required to emit a JSON manifest at run end listing every file path it created or modified.
- [ ] `ManifestValidator.validate(manifest: list[str], repo_path: str) -> ValidationResult` compares manifest against `git diff --name-only HEAD` output.
- [ ] Returns: `passed: bool`, `declared: list[str]`, `actual: list[str]`, `undeclared_changes: list[str]`, `phantom_declarations: list[str]`.
- [ ] A run passes manifest validation only if `undeclared_changes` is empty (phantom declarations are a warning, not a failure).
- [ ] Unit tests cover: exact match, missing file in manifest, extra file in manifest, empty manifest with no changes.

### Mutation Check
- [ ] `MutationValidator.run(repo_path: str, target_symbols: list[str], test_command: str) -> MutationResult` executes:
  1. Run `test_command` on the modified repo — must pass.
  2. For each target symbol, replace its implementation body with `raise NotImplementedError("stub")`.
  3. Run `test_command` again — must fail.
- [ ] Returns: `baseline_passed: bool`, `mutant_failed: bool`, `valid: bool` (`true` iff both conditions hold), per-symbol mutation results.
- [ ] Mutation is applied in a temporary git worktree, not in-place, so the original repo is never modified.
- [ ] If the test suite takes longer than 60 seconds, the mutation check is marked as timed out (not failed).
- [ ] Unit tests cover: correct agent change (baseline pass + mutant fail), trivially passing tests (baseline pass but mutant also passes → invalid), broken agent change (baseline fail).

## Implementation Notes

### Manifest Format

The agent is prompted to emit a manifest as part of its final response:

```json
{
  "manifest": {
    "modified": ["src/db/connection.py", "docs/db.md"],
    "created": ["docs/db_overview.md"],
    "deleted": []
  }
}
```

The evaluation harness should extract this block from the agent's final message.

### Mutation Granularity

For Python, replace the body of a function/method with `raise NotImplementedError(...)`. For TypeScript, replace the body with `throw new Error("stub")`. Use `tree-sitter` (already available from TICKET-002) to locate and replace the body node without touching the signature.

### Why Both Checks Together

Manifest check alone can be fooled by an agent that randomly edits files. Mutation check alone doesn't catch undeclared side effects. Together, they confirm: the agent touched exactly what it said it touched, and those changes are causally linked to test outcomes.

## Output Artifact

`eval/validators/manifest_validator.py`  
`eval/validators/mutation_validator.py`

## Dependencies

TICKET-001, TICKET-002

## Feeds Into

TICKET-010
