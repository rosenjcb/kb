---
type: Spec
title: "Spec: Contradiction Search"
sources: [./contradiction-search.ts]
tests: [../../../../tests/query/contradiction-search.test.ts]
description: Post-draft adversarial retrieval and optional answer revise on the live query path
resource: ./contradiction-search.ts
tags: [query, retrieval, contradiction, reasoning, spec]
timestamp: 2026-07-16T00:00:00Z
---

### Intro

After synthesis drafts an answer, contradiction search retrieves evidence that *disproves*
core claims and may revise the answer. Architecture: [CONTRADICTION_SEARCH.md](./CONTRADICTION_SEARCH.md).
Upstream retrieval: [QUERY_INTERNALS.md](../core/QUERY_INTERNALS.md). Curator gap-fill is separate:
[FACT_CURATOR.md](../tools/FACT_CURATOR.md).

### Definitions

- **Draft**: `data.answer` from `enrichReadDocumentsAnswerWithLLM`
- **Adversarial query**: short FTS query whose only goal is disconfirming evidence for a claim
- **Contradiction trace**: `{ ran, found, used, hitCount?, queries?, factIds? }` on `retrieval.contradiction`

### Scope

## In Scope
- Skip when no draft / empty evidence; claim extract; shallow adversarial search; filter; revise; telemetry; fail-safe

## Out of Scope
- Confidence from contradiction counts (#153)
- Live adversarial debate (#149)
- Curator gap re-discovery (pre-synthesis)

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | Skip the stage (record `ran: false`) when there is no draft answer or no evidence |
| FR-2 | Extract core claims and adversarial disprove queries from the draft |
| FR-3 | Run shallow `searchFacts` excluding already-known fact ids, with a hard per-query budget |
| FR-4 | Keep only candidate facts that actually contradict a claim |
| FR-5 | When contradiction hits exist, revise the draft and set `found`/`used` true on the trace |
| FR-6 | On LLM or search failure, keep the draft and record `ran: true`, `found: false`, `used: false` |
| FR-7 | Persist the contradiction audit on `retrieval.contradiction` for RunReport summarization |
| FR-8 | Adjust answer confidence from support vs contradict counts: `base * support / (support + contradict)` when contradict > 0 |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | No draft answer | `ran: false`; answer unchanged |
| TC-2 | FR-4 | Adversarial hits that do not contradict | `found: false`, `used: false`; draft kept |
| TC-3 | FR-5 | Filter returns contradicting fact ids | Answer revised; `found`/`used` true; fact ids recorded |
| TC-4 | FR-6 | LLM throws during claim extract | Draft kept; `ran: true`, `found: false` |
| TC-5 | FR-7 | Trace object on retrieval input | `summarizeQueryRetrievalTrace` lifts contradiction fields |
| TC-6 | FR-8 | Zero contradict count | Base confidence unchanged |
| TC-7 | FR-8 | Support 9, contradict 1, base 0.8 | Confidence becomes 0.72 |

### Related docs

- [CONTRADICTION_SEARCH.md](./CONTRADICTION_SEARCH.md)
- [QUERY_INTERNALS.md](../core/QUERY_INTERNALS.md)
- [FACT_CURATOR.spec.md](../tools/FACT_CURATOR.spec.md)
