---
type: Spec
title: "Spec: Retrieval-time checklists"
sources:
  - ./retrieval-checklists.ts
  - ../tools/facts-sufficiency-judge.ts
  - ../tools/query-expander.ts
tests:
  - ../../../../tests/query/retrieval-checklists.test.ts
  - ../../../../tests/tools/facts-sufficiency-judge.test.ts
  - ../../../../tests/tools/query-expander.test.ts
description: Classify questions to DocType and inject doc-questionnaire coverage into decompose/sufficiency/expand.
resource: ./retrieval-checklists.ts
tags: [spec, kb, query, retrieval]
timestamp: 2026-07-16T00:00:00Z
---

### Intro

Reuse `doc-questionnaires/<DocType>.md` (via `loadQuestionnaire`) as retrieval coverage
checklists at plan/judge time — not only at doc-gen. Heuristic classify; no extra LLM call.

### Definitions

- **Answer type** — a `DocType` inferred from the user question.
- **Coverage checklist** — questionnaire keys (minus `documentTitle`) phrased for retrieval.

### Scope

**In:** classify + format helper; sufficiency judge prompt; query expand user message; chat
decompose user message (client).

**Out:** curator schema; new DocTypes; LLM-based classify.

### Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-1 | `classifyQueryDocType` maps question shape to a `DocType` via heuristics |
| FR-2 | `formatRetrievalChecklist` loads questionnaire and omits `documentTitle` |
| FR-3 | Sufficiency judge injects the checklist and requires coverage-aware ANSWERABLE |
| FR-4 | Query expand appends the checklist block to the user message |

### QA Test Cases

| ID | FR | Scenario | Expected |
|----|-----|----------|----------|
| TC-1 | FR-1 | howto / how to question | classifies as `howto` |
| TC-2 | FR-1 | error / fix / runbook question | classifies as `runbook` |
| TC-3 | FR-1 | why / trade-off question | classifies as `decision` |
| TC-4 | FR-1 | API / CLI / flags question | classifies as `reference` |
| TC-5 | FR-1 | overview / what is this | classifies as `introduction` |
| TC-6 | FR-2 | format for `howto` | includes `goal`/`steps`, omits `documentTitle` |
| TC-7 | FR-3 | sufficiency judge LLM call | prompt includes Answer type + Coverage checklist |
| TC-8 | FR-4 | expandQuery LLM call | user content includes Coverage checklist |
