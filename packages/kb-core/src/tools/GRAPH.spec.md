---
type: Spec
title: "Spec: Knowledge Graph"
sources: ./tree-sitter-indexer.ts,../../tests/tools/graph-*.test.ts,../../tests/tools/triplet-extractor.test.ts
description: Behavioral specification for Knowledge Graph
tags: [spec, kb]
timestamp: 2026-06-28T04:05:29Z
---

### Intro

Behavioral requirements. Architecture: [GRAPH.md](GRAPH.md).

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
| FR-2 | Graph query expansion broadens retrieval queries via graph neighbors |
| FR-3 | Graph RAG reranker reorders candidates using graph proximity |
| FR-4 | Triplet extractor parses subject-predicate-object fact triplets |

> Code-graph **indexing** (symbol/edge extraction from source trees) is specified in
> [TREE_SITTER_INDEXER.spec.md](TREE_SITTER_INDEXER.spec.md) — the single tree-sitter indexer
> covers every language. This spec covers query expansion, reranking, and triplet extraction.

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-11 | FR-2 | Given a freeform query, then slug extraction produces unigrams and bigrams for graph entity matching | pass |
| TC-12 | FR-2 | Given facts in DB, then query expansion appends matching subject/object terms | pass |
| TC-13 | FR-2 | Given a DB with no matching facts, then expansion returns the original query | pass |
| TC-14 | FR-2 | Given exported symbols in facts, then expansion appends matching symbol names | pass |
| TC-15 | FR-2 | Given an empty DB, then expansion falls back gracefully to the original query | pass |
| TC-16 | FR-3 | parses a valid JSON array from LLM response | pass |
| TC-17 | FR-3 | extracts array even when surrounded by prose | pass |
| TC-18 | FR-3 | returns empty array when LLM returns non-JSON | pass |
| TC-19 | FR-3 | returns empty array when LLM call throws | pass |
| TC-20 | FR-3 | caps results at 8 entities | pass |
| TC-21 | FR-3 | returns results unchanged when no entities given | pass |
| TC-22 | FR-3 | returns results unchanged when fewer than 2 results | pass |
| TC-23 | FR-3 | boosts result whose content matches graph neighborhood terms | pass |
| TC-24 | FR-3 | boosts result whose graphEvidence matches | pass |
| TC-25 | FR-3 | preserves original order when connectivity scores are equal | pass |
| TC-26 | FR-3 | returns original results when graphWriter.expandQuery throws | pass |
| TC-27 | FR-4 | parses a single-element JSON array | pass |
| TC-28 | FR-4 | parses a multi-element array from a compound sentence | pass |
| TC-29 | FR-4 | falls back to bare object for backwards compat | pass |
| TC-30 | FR-4 | ignores surrounding prose and extracts the JSON array | pass |
| TC-31 | FR-4 | throws when output has no JSON | pass |
| TC-32 | FR-4 | throws when array contains no valid triples | pass |
| TC-33 | FR-4 | skips malformed rows but keeps valid ones | pass |
| TC-34 | FR-4 | returns the first triplet from a multi-triple response | pass |

### Related docs

- [GRAPH.md](GRAPH.md)

