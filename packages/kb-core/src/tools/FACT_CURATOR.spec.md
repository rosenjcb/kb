---
type: Spec
title: "Spec: Fact Curator"
sources: [./fact-curator.ts]
tests: [../../../../tests/tools/fact-curator.test.ts]
description: Post-retrieval relevance curation — judge-in-the-loop fact filtering before synthesis
tags: [query, retrieval, facts, curation, spec]
timestamp: 2026-08-02T23:10:00Z
---

### Intro

After retrieval grows a broad fact pool, the curator is the relevance gate before synthesis: keep what answers the question, hard-drop the rest, and re-discover gaps. Stack role and invariants: [FACT_CURATOR.md](./FACT_CURATOR.md). Upstream pipeline: [QUERY_INTERNALS.md](../core/QUERY_INTERNALS.md).

### Definitions

- **Curator**: `curateFacts()` judge-in-the-loop loop in `fact-curator.ts`
- **Verdict**: structured `{ keep, gaps, sufficient }` JSON from the LLM judge
- **Auto-keep**: deterministic high-overlap facts kept regardless of judge keep list
- **Re-discovery**: bounded shallow search when judge reports gaps and `sufficient` is false

### Scope

## In Scope
- Skip gate (`shouldCurate`), verdict parsing, curation loop, fail-safes

## Out of Scope
- Retrieval orchestration and island growth — [QUERY_INTERNALS.md](../core/QUERY_INTERNALS.md)
- Synthesis prompt assembly — curator output never injects dropped-fact text

### Functional Requirements

| ID   | Requirement |
|------|------------|
| FR-1 | Skip curation when the result pool is below the minimum threshold |
| FR-2 | Parse a structured judge verdict from LLM output |
| FR-3 | Hard-drop facts the judge rejects (below legacy relevance floor) |
| FR-4 | Auto-keep high token-overlap facts even when the judge omits them |
| FR-5 | Re-discover and admit new facts when the judge reports gaps |
| FR-6 | Fail safe on LLM or JSON parse errors — return the original pool |
| FR-7 | Never return an empty set after curation |
| FR-8 | Bound the judge candidate set on large pools (cap + hard-drop the tail; bounded fail-safe) |
| FR-9 | Rank auto-keep: preserve orchestrator top-N before the LLM judge |
| FR-10 | [NEW] Record why the curator fell back when the cause was an LLM error, so an outage is attributable rather than indistinguishable from a quiet no-op |
| FR-11 | [NEW] Record each judge round as a telemetry stage when a collector is supplied |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | More than threshold results | `shouldCurate` returns true |
| TC-2 | FR-1 | Few results | `shouldCurate` returns false |
| TC-3 | FR-2 | JSON object embedded in prose | Extracts keep, gaps, sufficient |
| TC-4 | FR-2 | No JSON in response | Throws |
| TC-5 | FR-3 | Irrelevant facts in pool | Only judge-kept facts remain |
| TC-6 | FR-4 | High-overlap fact omitted by judge | Fact auto-kept |
| TC-7 | FR-5 | Gaps reported, insufficient | Re-discovery runs and admits new facts |
| TC-8 | FR-6 | LLM throws | Original pool returned, `fellBack` set |
| TC-9 | FR-7 | Judge drops everything | Non-empty deterministic top-K fallback |
| TC-10 | FR-5 | Re-discovery returns only known ids | Loop stops without spinning |
| TC-11 | FR-8 | Pool larger than the candidate cap | Tail hard-dropped; judge sees at most the cap |
| TC-12 | FR-8 | LLM throws on an over-cap pool | Fail-safe bounded to the cap, not the full pool |
| TC-13 | FR-11 | Collector supplied and the judge runs | Each judge round recorded as a telemetry stage |
| TC-14 | FR-9 | Rank auto-keep enabled, judge keeps nothing | Top-N incoming facts still in keep set |
| TC-15 | FR-10 | LLM throws during judging | record carries the failure kind and stage alongside fellBack |

### Related docs

- [FACT_CURATOR.md](./FACT_CURATOR.md)
- [QUERY_INTERNALS.md](../core/QUERY_INTERNALS.md)
