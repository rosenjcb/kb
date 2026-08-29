---
type: Spec
title: "Spec: Query Intent & Claim Verification"
sources: [./]
# tests/query was previously owned by no spec, so its [TC-N] tags were orphan
# (`spec-md coverage` reported them as "tagged but not in spec"). This spec adopts
# them. Files with no TC tags are listed anyway so new tags land in scope here.
tests:
  - ../../../../tests/query/causal-claim-intent.test.ts
  - ../../../../tests/query/claim-verification.test.ts
  - ../../../../tests/query/query-pipeline-empty.test.ts
description: Question-shape detection and post-synthesis claim grounding on the kb query path
tags: [query, retrieval, synthesis, grounding, spec]
timestamp: 2026-08-24T03:30:00Z
---

### Intro

Two concerns on the `kb query` deep path that both act on the *question* or the *answer* rather than on ranking: recognizing what shape of question was asked so synthesis can be constrained accordingly, and checking the produced prose back against the evidence that was actually retrieved.

### Definitions

- **Causal question**: a question that asserts or denies that one thing affects another ("does X break Y") — the shape where retrieval can show presence but never absence
- **Causal target**: the side of that question a claim is being made *about* (the `Y`), which is the side retrieval tends not to visit
- **Required gap**: a caller-declared retrieval obligation handed to the curator, resolved regardless of the judge's `sufficient` verdict
- **Claim verification**: opt-in second pass (`KB_QUERY_VERIFY_CLAIMS`) that re-reads the answer against the evidence and flags unsupported prose claims

### Scope

## In Scope
- Causal-question detection and the synthesis guidance it triggers
- Claim extraction, the opt-in gate, and its confidence floor

## Out of Scope
- Ranking and fusion — [hybrid-retriever](../tools/)
- Curator keep/drop mechanics — [FACT_CURATOR.spec.md](../tools/FACT_CURATOR.spec.md)
- Always-on file-name grounding (`findUngroundedFileReferences`) — [CORE.spec.md](../core/CORE.spec.md)

### Functional Requirements

| ID   | Requirement |
|------|------------|
| FR-1 | Detect a causal/negative-claim question and extract the target it makes a claim about |
| FR-2 | Return no target for ordinary lookup questions, so a non-matching query pays no extra retrieval |
| FR-3 | Bound the extracted target to a usable retrieval probe rather than a restated sentence |
| FR-4 | Build a probe that asks for the target's own definition and state handling |
| FR-5 | Gate the guard on `KB_QUERY_NEGATIVE_CLAIM_GUARD`, defaulting on, with unrecognized values treated as on |
| FR-6 | Synthesis guidance must state that absence of evidence is not evidence of absence, and require naming what was not inspected |
| FR-7 | Extract prose claims from a verifier reply, tolerating bullets, numbering, and a bare NONE |
| FR-8 | Cap the extracted claim list so one runaway reply cannot flood the caller |
| FR-9 | Claim verification is opt-in — off by default, enabled by env or explicit parameter, and floored on evidence confidence |
| FR-10 | Report flagged claims with token usage echoed back to the caller |
| FR-11 | An empty retrieval pool short-circuits the pipeline without synthesizing |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-NCG1 | FR-1 | "could X leave Y in a state where…" | Extracts Y as the target |
| TC-NCG2 | FR-1 | "does X affect Y" | Extracts Y, not X |
| TC-NCG3 | FR-1 | "is Y affected by X" | Extracts Y from the leading position |
| TC-NCG4 | FR-1 | "without breaking Y" | Extracts Y |
| TC-NCG5 | FR-2 | Plain lookup question, or empty string | Returns null |
| TC-NCG6 | FR-3 | Trailing subordinate clause after the target | Target stops before the clause |
| TC-NCG7 | FR-3 | Very long trailing phrase | Target capped to at most 8 words |
| TC-NCG8 | FR-3 | Leading article on the target | Article stripped |
| TC-NCG9 | FR-4 | A detected target | Probe names the target and asks for its definition |
| TC-NCGA | FR-5 | No env var set | Guard enabled |
| TC-NCGB | FR-5 | `KB_QUERY_NEGATIVE_CLAIM_GUARD=false` | Guard disabled |
| TC-NCGC | FR-5 | Unrecognized env value | Guard stays enabled |
| TC-NCGD | FR-6 | Guidance text | States absence is not evidence of absence; requires naming what was not inspected |
| TC-CV00 | FR-7 | A lone NONE in any case/punctuation | Treated as everything supported |
| TC-CV01 | FR-7 | Bulleted and numbered claim lines | Markers stripped, claims parsed |
| TC-CV02 | FR-7 | Repeated claims and stray NONE lines | Deduped, NONE dropped |
| TC-CV03 | FR-8 | Runaway reply with many claims | List capped |
| TC-CV04 | FR-9 | No env, no param | Verification off |
| TC-CV05 | FR-9 | Explicit param supplied | Param overrides the env default |
| TC-CV06 | FR-9 | `KB_QUERY_VERIFY_CLAIMS=true` | Enabled, but only above the confidence floor |
| TC-CV07 | FR-9 | `KB_QUERY_VERIFY_MIN_CONFIDENCE` set | Floor is configurable |
| TC-CV08 | FR-9 | Opted in with no evidence label | Runs anyway |
| TC-CV09 | FR-10 | Verifier flags claims | Returns flagged claims and echoes token usage |
| TC-CV10 | FR-10 | Verifier reply handling | Reported without sinking the answer |
| TC-CV11 | FR-10 | Verifier failure | Degraded, answer preserved |
| TC-QPE1 | FR-11 | Retrieval returns nothing | Pipeline short-circuits without synthesis |
