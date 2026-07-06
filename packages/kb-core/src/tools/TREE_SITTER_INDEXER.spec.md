---
type: Spec
title: "Spec: Tree-Sitter Code Graph Indexer"
sources: ./tree-sitter-indexer.ts
tests: ../../../../tests/tools/tree-sitter-indexer.test.ts,../../../../tests/tools/ast-source-text.test.ts
description: Behavioral specification for Tree-Sitter Code Graph Indexer
tags: [spec, kb]
timestamp: 2026-06-28T04:05:29Z
---

### Intro

Behavioral requirements. Architecture: [TREE_SITTER_INDEXER.md](TREE_SITTER_INDEXER.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- See related companion docs for architectural boundaries

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Tree-sitter indexer parses ASTs (every language) and indexes code symbols, import edges, constant values, and `extends`/`implements` structural edges |
| FR-2 | AST source text reconstruction preserves exact source spans |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | indexes exported functions and types | pass |
| TC-2 | FR-1 | indexes exported methods | pass |
| TC-3 | FR-1 | indexes exported constants and variables | pass |
| TC-4 | FR-1 | emits IMPORTS_FILE edges for resolvable local Go imports | pass |
| TC-5 | FR-1 | does not emit IMPORTS_FILE edges for unresolvable Go module paths | pass |
| TC-6 | FR-1 | skips unchanged files on re-index | pass |
| TC-7 | FR-1 | indexes exported classes and functions | pass |
| TC-8 | FR-1 | indexes exported interfaces and type aliases | pass |
| TC-9 | FR-1 | emits IMPORTS_FILE facts for local TS imports | pass |
| TC-10 | FR-1 | indexes exported components and functions from .tsx files | pass |
| TC-11 | FR-1 | indexes functions and classes | pass |
| TC-12 | FR-1 | indexes functions and structs | pass |
| TC-13 | FR-1 | indexes elements with id attributes | pass |
| TC-14 | FR-1 | creates a code_file_state entry for non-code files without extracting symbols | pass |
| TC-15 | FR-1 | ignores unknown extensions not in the allowlist | pass |
| TC-16 | FR-1 | indexes code and text files together in one pass | pass |
| TC-17 | FR-2 | source_text column exists after runMigrations | pass |
| TC-18 | FR-2 | stores sourceText and returns it in FactRow | pass |
| TC-19 | FR-2 | stores NULL when sourceText is omitted | pass |
| TC-20 | FR-2 | updates sourceText on re-upsert of same normalized fact | pass |
| TC-21 | FR-2 | getActiveFactById includes source_text | pass |
| TC-22 | FR-2 | returns source_text as content when source_kind=import_code and source_text present | pass |
| TC-23 | FR-2 | falls back to fact_text when source_kind=import_code but source_text is NULL | pass |
| TC-24 | FR-2 | always uses fact_text for import_doc and submit facts even if source_text were set | pass |
| TC-25 | FR-2 | does not include content when includeContent=false, regardless of source_text | pass |
| TC-26 | FR-2 | the indexer stores full declaration text capped at 1500 chars | pass |
| TC-27 | FR-2 | source text within limit passes through unchanged | pass |
| TC-28 | FR-1 | emits EXTENDS and IMPLEMENTS structural facts for classes (TS/JS) | pass |
| TC-29 | FR-1 | includes the value in fact text for exported constants with literal initializers | pass |
| TC-30 | FR-1 | extracts top-level non-exported constants with literal values, skipping complex ones | pass |
| TC-31 | FR-1 | indexes only the files passed as candidateFiles | pass |
| TC-32 | FR-1 | finds exported symbols matching query terms via FTS (CodeGraphStore) | pass |
| TC-33 | FR-1 | getSummary returns symbol and file counts (CodeGraphStore) | pass |

### Related docs

- [TREE_SITTER_INDEXER.md](TREE_SITTER_INDEXER.md)

