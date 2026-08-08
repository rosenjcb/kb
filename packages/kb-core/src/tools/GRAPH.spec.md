---
type: Spec
title: "Spec: Knowledge Graph"
sources: [./triplet-extractor.ts]
tests:
  - ../../../../tests/tools/triplet-extractor.test.ts
description: Behavioral specification for Knowledge Graph
tags: [spec, kb]
timestamp: 2026-08-08T22:45:00Z
---

### Intro

Triplet extraction for curated fact text. Code-graph indexing is in
[TREE_SITTER_INDEXER.spec.md](TREE_SITTER_INDEXER.spec.md). Hybrid retrieval is in
[TOOLS.spec.md](TOOLS.spec.md). Architecture: [GRAPH.md](GRAPH.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- Structural code-graph BFS, query expansion, and RAG proximity reranking (retired in indexing redesign)

### Functional Requirements

| ID | Requirement |
| ------ | ------------ |
| FR-1 | Triplet extractor parses subject-predicate-object fact triplets |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-1 | FR-1 | parses a single-element JSON array | pass |
| TC-2 | FR-1 | parses a multi-element array from a compound sentence | pass |
| TC-3 | FR-1 | falls back to bare object for backwards compat | pass |
| TC-4 | FR-1 | ignores surrounding prose and extracts the JSON array | pass |
| TC-5 | FR-1 | throws when output has no JSON | pass |
| TC-6 | FR-1 | throws when array contains no valid triples | pass |
| TC-7 | FR-1 | skips malformed rows but keeps valid ones | pass |
| TC-8 | FR-1 | returns the first triplet from a multi-triple response | pass |

### Related docs

- [GRAPH.md](GRAPH.md)
