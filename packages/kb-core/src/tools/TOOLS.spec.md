---
type: Spec
title: "Spec: KB Tools"
sources: [./]
# Precise, disjoint scope: tests/tools minus the files owned by the per-tool
# specs (FACT_CURATOR, GRAPH, TREE_SITTER_INDEXER). TC ids are per-spec, so a
# whole-dir claim would over-select their [TC-N] tags. Add new tests/tools files
# here when they carry TOOLS [TC-N] tags.
tests:
  - ../../../../tests/tools/document-writer.test.ts
  - ../../../../tests/tools/facts-document-reader.test.ts
  - ../../../../tests/tools/invalidate-fact-tool.test.ts
  - ../../../../tests/tools/kb-tools-registry-no-doc-writes.test.ts
  - ../../../../tests/tools/markdown-md-writer-tool.test.ts
  - ../../../../tests/tools/query-expander.test.ts
  - ../../../../tests/tools/retrieval-checkpoint-orchestrator.test.ts
  - ../../../../tests/tools/specialized-document-operations.test.ts
  - ../../../../tests/tools/sqlite-kb-index.test.ts
  - ../../../../tests/tools/subagent-eval-scenario.test.ts
  - ../../../../tests/tools/subagent-scenario-matrix.test.ts
  - ../../../../tests/tools/task-tool.test.ts
  - ../../../../tests/tools/hybrid-retriever.test.ts
description: Behavioral specification for KB Tools
tags: [spec, kb]
timestamp: 2026-08-16T00:00:00Z
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
| FR-3 | Hybrid retrieval over documents, code symbols, and curated facts (`hybrid-retriever.test.ts`) |
| FR-4 | Behaviors in facts-document-reader.test.ts |
| FR-5 | Behaviors in kb-tools-registry-no-doc-writes.test.ts |
| FR-6 | Behaviors in query-expander.test.ts |
| FR-7 | Behaviors in invalidate-fact-tool.test.ts |
| FR-8 | Behaviors in document-writer.test.ts |
| FR-9 | Behaviors in specialized-document-operations.test.ts |
| FR-10 | Behaviors in task-tool.test.ts |
| FR-11 | Behaviors in subagent-scenario-matrix.test.ts |
| FR-12 | Behaviors in subagent-eval-scenario.test.ts |
| FR-13 | Behaviors in retrieval-checkpoint-orchestrator.test.ts |
| FR-14 | Behaviors in markdown-md-writer-tool.test.ts |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | Given write_document with sqlite indexing enabled, then should upsert original_docs record | pass |
| TC-2 | FR-1 | Given append/update/prune mutations, then should keep original_docs markdown synchronized | pass |
| TC-3 | FR-1 | Given indexed content hash, then should report staleness only when content changes | pass |
| TC-4 | FR-1 | Given repeated miss events with candidates, then should persist miss clusters and accumulate ranking hints | pass |
| TC-5 | FR-1 | Given checkpoint event traces, then should compute stage metrics and promote rollout when thresholds are met | pass |
| TC-6 | FR-1 | Given poor checkpoint outcomes, then rollout assessment should rollback | pass |
| TC-7 | FR-1 | Given a document upsert, then getDocument returns the body | pass |
| TC-8 | FR-1 | Given natural language query, searchFacts should match token-level evidence | pass |
| TC-9 | FR-1 | Given lane routing events, then should report lane-level precision and fallback indicators | pass |
| TC-10 | FR-1 | Given weak lane-routing metrics, then lane rollout assessment should rollback | pass |
| TC-19 | FR-4 | expands generic query via LLM and merges results from all sub-queries | pass |
| TC-20 | FR-4 | skips expansion when query has enough meaningful tokens | pass |
| TC-21 | FR-4 | falls back to single-query when LLM returns empty expansion | pass |
| TC-22 | FR-4 | Given allFacts in input, then returns all facts without query-based filtering | pass |
| TC-23 | FR-4 | Given defaultAllFacts constructor param, then every queryDocuments call uses all-facts mode | pass |
| TC-24 | FR-4 | Given all_facts mode, then second call in same session returns empty (already-in-context) | pass |
| TC-25 | FR-4 | Given all_facts mode via input flag, then deduplication also applies on second call | pass |
| TC-26 | FR-4 | Given allFacts mode, then LLM query expansion is never invoked | pass |
| TC-27 | FR-5 | does not register markdown-era doc-write or legacy graph/read tool names | pass |
| TC-28 | FR-6 | expands single-token queries | pass |
| TC-29 | FR-6 | expands when only stop words plus one noun remain | pass |
| TC-30 | FR-6 | expands two-meaningful-token queries | pass |
| TC-31 | FR-6 | does not expand three-meaningful-token queries | pass |
| TC-32 | FR-6 | does not expand specific multi-word queries | pass |
| TC-33 | FR-6 | returns true for empty query | pass |
| TC-34 | FR-6 | parses a valid JSON array from LLM output | pass |
| TC-35 | FR-6 | strips prose surrounding the JSON array | pass |
| TC-36 | FR-6 | returns empty array when LLM returns no JSON | pass |
| TC-37 | FR-6 | returns empty array on malformed JSON | pass |
| TC-38 | FR-6 | caps results at 4 even if LLM returns more | pass |
| TC-39 | FR-6 | filters out non-string entries | pass |
| TC-40 | FR-7 | replaces a canonical fact with replacement | pass |
| TC-41 | FR-7 | removes a canonical fact if no replacement | pass |
| TC-42 | FR-7 | does not inspect or edit arbitrary repo files beside the KB store | pass |
| TC-43 | FR-7 | matches stored fact when oldFact has extra whitespace (same normalization as upsert) | pass |
| TC-44 | FR-7 | returns error if no matches exist in KB documents | pass |
| TC-45 | FR-8 | Given valid write_document input, then should return the writer result | pass |
| TC-46 | FR-8 | Given non-object tool input, then should throw validation error | pass |
| TC-47 | FR-8 | Given empty title input, then should throw validation error | pass |
| TC-48 | FR-8 | Given non-string tags entries, then should throw validation error | pass |
| TC-49 | FR-8 | Given valid document type, then should pass parsed type to writer | pass |
| TC-50 | FR-8 | Given invalid document type, then should throw validation error | pass |
| TC-51 | FR-9 | Given append_to_document, then should append content at bottom by default | pass |
| TC-52 | FR-9 | Given append_to_document with top position, then should prepend content | pass |
| TC-53 | FR-9 | Given update_document, then should replace content and preserve created timestamp | pass |
| TC-54 | FR-9 | Given prune_document, then should remove matching section and keep others | pass |
| TC-55 | FR-9 | Given merge_documents in user-decides mode, then should return pending approval status | pass |
| TC-56 | FR-9 | Given merge_documents in auto mode, then should return merged status | pass |
| TC-57 | FR-9 | Given reconcileFacts default policy, then replaces in non-session docs and skips session-log docs | pass |
| TC-58 | FR-9 | Given reconcileFacts with includeSessionLogs true, then updates session-log documents too | pass |
| TC-59 | FR-10 | Given empty prompt, then returns validation error | pass |
| TC-60 | FR-10 | Given subagent read_facts turn then text turn, then succeeds with trace | pass |
| TC-61 | FR-11 | runs orchestrator scenario matrix (optional ~/.kb/evaluations/_matrix snapshot) | pass |
| TC-62 | FR-13 | Given result counts, then assessResultCount returns deterministic labels | pass |
| TC-63 | FR-13 | Given a strong hybrid hit, then next action is return | pass |
| TC-64 | FR-13 | Given a lexical stage with no evidence, then next action advances to rewrite retry | pass |
| TC-65 | FR-13 | Given rewrite retry stage, then next action always returns | pass |
| TC-66 | FR-14 | Given a new document input, then should write markdown file and index table entry | pass |
| TC-67 | FR-14 | Given duplicate document titles without overwrite, then should create a unique suffixed file id | pass |
| TC-68 | FR-14 | Given overwrite true on an existing id, then should replace the same document path | pass |
| TC-69 | FR-12 | each subagent eval scenario | loop tuning matches the scenario profile |
| TC-70 | FR-3 | hybrid retrieval returns ranked documents and code symbols for a natural-language query | pass |
| TC-71 | FR-3 | hybrid retrieval detail reports docs/symbols/facts/hops counts | pass |
| TC-72 | FR-3 | one-hop join surfaces symbols linked from a top document | pass |
| TC-73 | FR-1 | upsertDocument invalidates the stale embedding on content change so only changed docs are re-embedded | pass |
| TC-74 | FR-1 | countUnembeddedRows reports pending counts, and embedAll emits a per-batch start and success event that counts remaining down to zero | pass |
| TC-75 | FR-1 | embedAll emits a retry event when the embedder backs off, and restores the embedder retry hook after it finishes | pass |
| TC-76 | FR-3 | KB_HYBRID_KIND_WEIGHT lets a narrow symbol outrank a broad document tied on rank (#216) | pass |

### Related docs

- [TOOL_CONVENTIONS.md](TOOL_CONVENTIONS.md)

