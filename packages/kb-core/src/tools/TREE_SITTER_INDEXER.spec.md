---
type: Spec
title: "Spec: Tree-Sitter Code Graph Indexer"
sources: [./tree-sitter-indexer.ts]
tests:
  - ../../../../tests/tools/tree-sitter-indexer.test.ts
description: Behavioral specification for Tree-Sitter Code Graph Indexer
tags: [spec, kb]
timestamp: 2026-08-16T21:41:00Z
---

### Intro

Behavioral requirements. Architecture: [TREE_SITTER_INDEXER.md](TREE_SITTER_INDEXER.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- Code→code structural edges (imports/extends/implements) in v1 — symbols and source text only

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Tree-sitter indexer parses ASTs and indexes code symbols with source text (no structural edge facts in v1) |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-QXNY | FR-1 | indexes exported functions and types | pass |
| TC-RH8M | FR-1 | indexes exported methods | pass |
| TC-ASLD | FR-1 | indexes exported constants and variables | pass |
| TC-P4LY | FR-1 | does not emit structural import edges (v1 indexes symbols only) | pass |
| TC-DRVZ | FR-1 | does not emit IMPORTS_FILE edges for unresolvable Go module paths | pass |
| TC-ANJ4 | FR-1 | skips unchanged files on re-index | pass |
| TC-11O9 | FR-1 | indexes exported classes and functions | pass |
| TC-3FNF | FR-1 | indexes exported interfaces and type aliases | pass |
| TC-954G | FR-1 | does not emit IMPORTS_FILE facts (v1 indexes symbols only) | pass |
| TC-0X92 | FR-1 | indexes exported components and functions from .tsx files | pass |
| TC-2EDD | FR-1 | indexes functions and classes | pass |
| TC-YBB8 | FR-1 | indexes functions and structs | pass |
| TC-5QN9 | FR-1 | indexes elements with id attributes | pass |
| TC-ATAZ | FR-1 | creates a code_file_state entry for non-code files without extracting symbols | pass |
| TC-UPJ4 | FR-1 | ignores unknown extensions not in the allowlist | pass |
| TC-ROFO | FR-1 | indexes code and text files together in one pass | pass |
| TC-YUE1 | FR-1 | does not emit EXTENDS/IMPLEMENTS structural facts (v1 symbols only) | pass |
| TC-0JE8 | FR-1 | stores source_text for exported constants with literal initializers | pass |
| TC-HAEK | FR-1 | indexes top-level non-exported constants with literal values as symbols | pass |
| TC-AX0K | FR-1 | indexes only the files passed as candidateFiles | pass |
| TC-M54E | FR-1 | finds exported symbols matching query terms via FTS (CodeGraphStore) | pass |
| TC-VJA3 | FR-1 | getSummary returns symbol and file counts (CodeGraphStore) | pass |
| TC-ESY9 | FR-1 | indexes exported functions from .jsx files | pass |
| TC-T083 | FR-1 | indexes .vue/.svelte/.svlete/.astro as text-state entries | pass |

### Related docs

- [TREE_SITTER_INDEXER.md](TREE_SITTER_INDEXER.md)
