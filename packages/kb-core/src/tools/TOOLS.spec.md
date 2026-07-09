---
type: Spec
title: "Spec: KB Tools"
sources: [./]
# Precise, disjoint scope: tests/tools minus the files owned by the per-tool
# specs (FACT_CURATOR, GRAPH, TREE_SITTER_INDEXER). TC ids are per-spec, so a
# whole-dir claim would over-select their [TC-N] tags. Add new tests/tools files
# here when they carry TOOLS [TC-N] tags.
tests:
  - ../../../../tests/tools/cross-repo-reconcile.test.ts
  - ../../../../tests/tools/document-writer.test.ts
  - ../../../../tests/tools/facts-document-reader.test.ts
  - ../../../../tests/tools/facts-query-research-orchestrator.test.ts
  - ../../../../tests/tools/facts-sufficiency-judge.test.ts
  - ../../../../tests/tools/invalidate-fact-tool.test.ts
  - ../../../../tests/tools/kb-tools-registry-no-doc-writes.test.ts
  - ../../../../tests/tools/markdown-md-writer-tool.test.ts
  - ../../../../tests/tools/query-expander.test.ts
  - ../../../../tests/tools/query-trace.test.ts
  - ../../../../tests/tools/retrieval-checkpoint-orchestrator.test.ts
  - ../../../../tests/tools/specialized-document-operations.test.ts
  - ../../../../tests/tools/sqlite-kb-index.test.ts
  - ../../../../tests/tools/subagent-eval-scenario.test.ts
  - ../../../../tests/tools/subagent-scenario-matrix.test.ts
  - ../../../../tests/tools/task-tool.test.ts
description: Behavioral specification for KB Tools
tags: [spec, kb]
timestamp: 2026-06-28T04:05:29Z
---

### Intro

Behavioral requirements. Architecture: [TOOL_CONVENTIONS.md](TOOL_CONVENTIONS.md).

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
| FR-1 | Behaviors in sqlite-kb-index.test.ts |
| FR-2 | Behaviors in cross-repo-reconcile.test.ts |
| FR-3 | Behaviors in facts-sufficiency-judge.test.ts |
| FR-4 | Behaviors in facts-query-research-orchestrator.test.ts |
| FR-5 | Behaviors in facts-document-reader.test.ts |
| FR-6 | Behaviors in kb-tools-registry-no-doc-writes.test.ts |
| FR-7 | Behaviors in query-expander.test.ts |
| FR-8 | Behaviors in invalidate-fact-tool.test.ts |
| FR-9 | Behaviors in document-writer.test.ts |
| FR-10 | Behaviors in specialized-document-operations.test.ts |
| FR-11 | Behaviors in task-tool.test.ts |
| FR-12 | Behaviors in subagent-scenario-matrix.test.ts |
| FR-13 | Behaviors in subagent-eval-scenario.test.ts |
| FR-14 | Behaviors in retrieval-checkpoint-orchestrator.test.ts |
| FR-15 | Behaviors in markdown-md-writer-tool.test.ts |
| FR-16 | Behaviors in query-trace.test.ts |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | Given write_document with sqlite indexing enabled, then should upsert original_docs record | pass |
| TC-2 | FR-1 | Given append/update/prune mutations, then should keep original_docs markdown synchronized | pass |
| TC-3 | FR-1 | Given indexed content hash, then should report staleness only when content changes | pass |
| TC-4 | FR-1 | Given repeated miss events with candidates, then should persist miss clusters and accumulate ranking hints | pass |
| TC-5 | FR-1 | Given checkpoint event traces, then should compute stage metrics and promote rollout when thresholds are met | pass |
| TC-6 | FR-1 | Given poor checkpoint outcomes, then rollout assessment should rollback | pass |
| TC-7 | FR-1 | Given facts-first schema, then backfillDocumentLanes is a no-op | pass |
| TC-8 | FR-1 | Given fact concepts, indexer can search and expand through concept graph | pass |
| TC-9 | FR-1 | Given fact_edges, getFactNeighbors walks both directions and skips seen ids | pass |
| TC-10 | FR-1 | Given natural language query, searchFacts should match token-level evidence | pass |
| TC-11 | FR-1 | Given lane routing events, then should report lane-level precision and fallback indicators | pass |
| TC-12 | FR-1 | Given weak lane-routing metrics, then lane rollout assessment should rollback | pass |
| TC-13 | FR-2 | bridges repos via package dependency and cross-repo symbol imports | pass |
| TC-14 | FR-2 | lets graph traversal cross repo boundaries | pass |
| TC-15 | FR-2 | is idempotent on re-run | pass |
| TC-16 | FR-2 | does not link a repo to itself | pass |
| TC-17 | FR-2 | removing a repo purges its facts and drops dangling cross-repo links | pass |
| TC-18 | FR-3 | Given ANSWERABLE response, then returns answerable | pass |
| TC-19 | FR-3 | Given INSUFFICIENT response, then returns insufficient | pass |
| TC-20 | FR-3 | Given partial ANSWERABLE prefix in response, then still returns answerable | pass |
| TC-21 | FR-3 | Given fewer facts than minimum threshold, then returns insufficient without calling LLM | pass |
| TC-22 | FR-3 | Given LLM throws, then returns insufficient as fallback | pass |
| TC-23 | FR-3 | Returns true when iteration is a multiple of JUDGE_CALL_INTERVAL and enough relevant facts | pass |
| TC-24 | FR-3 | Returns false when not on a call interval | pass |
| TC-25 | FR-3 | Returns false when relevant facts below threshold regardless of interval | pass |
| TC-26 | FR-4 | Given multi-token query, then builds primary, pair, and single-token ponds | pass |
| TC-27 | FR-4 | Given maxPonds -1, then returns every generated pond query | pass |
| TC-28 | FR-4 | Given fewer than 20 relevant facts, then loop does not stop early on sufficiency | pass |
| TC-29 | FR-4 | Given 20+ relevant high-scoring facts, then loop stops as answerable | pass |
| TC-30 | FR-4 | Given reserved anchor and source slots overlap, then buildResponse dedupes fact ids | pass |
| TC-31 | FR-4 | Given generated _site code facts, then they are excluded from surfaced results | pass |
| TC-32 | FR-4 | Given disjoint doc and code facts, pond search keeps primary lexical anchors in results | pass |
| TC-33 | FR-4 | Given more facts than MAX_FACTS_FOR_LLM, then results are capped at 150 | pass |
| TC-34 | FR-4 | Given retrieval detail, then it includes facts count | pass |
| TC-35 | FR-4 | Given plateau of low-quality facts with no new relevant facts, then loop stops within 3 extra iterations | pass |
| TC-36 | FR-4 | Given code fact linked via graph to a high-scoring doc fact, then it ranks higher than an identifier-only code fact | pass |
| TC-37 | FR-4 | Given judge returns answerable, then loop stops with llm_judge_answerable | pass |
| TC-38 | FR-4 | Given judge returns insufficient, then loop continues past the judge call | pass |
| TC-39 | FR-4 | Given no judge provided, then orchestrator runs without judge calls | pass |
| TC-40 | FR-5 | uses iterative facts loop for deep discovery | pass |
| TC-41 | FR-5 | marks weak evidence after exhaustion without requiring chat-only deepen hints | pass |
| TC-42 | FR-5 | continues expanding graph hops while novel concepts exist | pass |
| TC-43 | FR-5 | expands generic query via LLM and merges results from all sub-queries | pass |
| TC-44 | FR-5 | skips expansion when query has enough meaningful tokens | pass |
| TC-45 | FR-5 | falls back to single-query when LLM returns empty expansion | pass |
| TC-46 | FR-5 | Given allFacts in input, then returns all facts without query-based filtering | pass |
| TC-47 | FR-5 | Given defaultAllFacts constructor param, then every queryDocuments call uses all-facts mode | pass |
| TC-48 | FR-5 | Given all_facts mode, then second call in same session returns empty (already-in-context) | pass |
| TC-49 | FR-5 | Given all_facts mode via input flag, then deduplication also applies on second call | pass |
| TC-50 | FR-5 | Given allFacts mode, then LLM query expansion is never invoked | pass |
| TC-51 | FR-6 | does not register markdown-era doc-write or legacy graph/read tool names | pass |
| TC-52 | FR-7 | expands single-token queries | pass |
| TC-53 | FR-7 | expands when only stop words plus one noun remain | pass |
| TC-54 | FR-7 | expands two-meaningful-token queries | pass |
| TC-55 | FR-7 | does not expand three-meaningful-token queries | pass |
| TC-56 | FR-7 | does not expand specific multi-word queries | pass |
| TC-57 | FR-7 | returns true for empty query | pass |
| TC-58 | FR-7 | parses a valid JSON array from LLM output | pass |
| TC-59 | FR-7 | strips prose surrounding the JSON array | pass |
| TC-60 | FR-7 | returns empty array when LLM returns no JSON | pass |
| TC-61 | FR-7 | returns empty array on malformed JSON | pass |
| TC-62 | FR-7 | caps results at 4 even if LLM returns more | pass |
| TC-63 | FR-7 | filters out non-string entries | pass |
| TC-64 | FR-8 | replaces a canonical fact with replacement | pass |
| TC-65 | FR-8 | removes a canonical fact if no replacement | pass |
| TC-66 | FR-8 | does not inspect or edit arbitrary repo files beside the KB store | pass |
| TC-67 | FR-8 | matches stored fact when oldFact has extra whitespace (same normalization as upsert) | pass |
| TC-68 | FR-8 | returns error if no matches exist in KB documents | pass |
| TC-69 | FR-9 | Given valid write_document input, then should return the writer result | pass |
| TC-70 | FR-9 | Given non-object tool input, then should throw validation error | pass |
| TC-71 | FR-9 | Given empty title input, then should throw validation error | pass |
| TC-72 | FR-9 | Given non-string tags entries, then should throw validation error | pass |
| TC-73 | FR-9 | Given valid document type, then should pass parsed type to writer | pass |
| TC-74 | FR-9 | Given invalid document type, then should throw validation error | pass |
| TC-75 | FR-10 | Given append_to_document, then should append content at bottom by default | pass |
| TC-76 | FR-10 | Given append_to_document with top position, then should prepend content | pass |
| TC-77 | FR-10 | Given update_document, then should replace content and preserve created timestamp | pass |
| TC-78 | FR-10 | Given prune_document, then should remove matching section and keep others | pass |
| TC-79 | FR-10 | Given merge_documents in user-decides mode, then should return pending approval status | pass |
| TC-80 | FR-10 | Given merge_documents in auto mode, then should return merged status | pass |
| TC-81 | FR-10 | Given reconcileFacts default policy, then replaces in non-session docs and skips session-log docs | pass |
| TC-82 | FR-10 | Given reconcileFacts with includeSessionLogs true, then updates session-log documents too | pass |
| TC-83 | FR-11 | Given empty prompt, then returns validation error | pass |
| TC-84 | FR-11 | Given subagent read_facts turn then text turn, then succeeds with trace | pass |
| TC-85 | FR-12 | writes evaluation/runs orchestrator matrix snapshot | pass |
| TC-86 | FR-14 | Given result counts, then estimateConfidence returns deterministic bands | pass |
| TC-87 | FR-14 | Given high-confidence hybrid hit, then next action is return | pass |
| TC-88 | FR-14 | Given low-confidence lexical stage, then next action advances to rewrite retry | pass |
| TC-89 | FR-14 | Given rewrite retry stage, then next action always returns | pass |
| TC-90 | FR-15 | Given a new document input, then should write markdown file and index table entry | pass |
| TC-91 | FR-15 | Given duplicate document titles without overwrite, then should create a unique suffixed file id | pass |
| TC-92 | FR-15 | Given overwrite true on an existing id, then should replace the same document path | pass |
| TC-93 | FR-16 | Given KB_QUERY_TRACE unset or false, then tracing is off (default) | pass |
| TC-94 | FR-16 | Given KB_QUERY_TRACE=true (any case), then tracing is on | pass |
| TC-95 | FR-16 | Given a code fact, then dumps source_text (the actual code) with rounded score | pass |
| TC-96 | FR-16 | Given a doc fact with no repo, then dumps fact_text and omits repo | pass |
| TC-97 | FR-16 | Given a curator record, then recovers dropped fact content by id from the lanes | pass |
| TC-98 | FR-16 | Given a dump, then writes traceId json that round-trips | pass |
| TC-99 | FR-16 | Given KB_QUERY_TRACE=true, then run attaches a lane dumping every discovered fact | pass |
| TC-100 | FR-16 | Given --trace on a deep query, then the reader writes a dump under KB_HOME/traces | pass |
| TC-101 | FR-16 | Given tracing off, then run attaches no lane | pass |

### Related docs

- [TOOL_CONVENTIONS.md](TOOL_CONVENTIONS.md)

