# Implement typed-lane indexing and runtime relevance-routed retrieval

## Ticket ID
075

## Theme
intelligence

## Problem
Current retrieval still over-mixes broad document categories, which can cause semantically similar but low-relevance sources (for example session logs) to outrank fact-focused docs for operational questions.

## Scope
- Define and implement typed indexing lanes (for example: error-runbook, fact, policy, architecture, session-log).
- Add runtime relevance routing that pre-filters candidate lanes before hybrid/vector scoring.
- Keep title influence low and prioritize fact/evidence quality plus lane fitness.

## Acceptance Criteria
- Retrieval can restrict candidate sets by lane based on query intent and evidence signals.
- Lane-aware retrieval improves operational query precision over mixed-lane baseline.
- Title text is not a primary ranking signal in lane-aware mode.

## Dependencies
072
073
074

## Deliverables
- Lane schema + indexing migration plan.
- Runtime lane router and integration into shared reader path.
- Evaluation scenarios comparing mixed-lane vs lane-routed precision.

## Estimate
M

## Priority
High

---

## Implementation Plan

### Typed-Lane Retrieval Architecture for Relevance-Routed Runtime

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
	- Define lane taxonomy and indexing strategy
	- Define runtime lane-routing policy and ranking priorities
	- Define evaluation and rollout guardrails
- ⏳ Phase 2 (Implementation): Deferred to follow-up tickets
	- 076: lane schema + index migration/backfill
	- 077: runtime lane router + lane-aware retrieval
	- 078: evaluation fixtures + rollout guardrails

#### Background
Mixed-category retrieval causes low-relevance but semantically similar documents (for example session logs) to surface for operational queries. We need lane-aware candidate routing so retrieval focuses on evidence-appropriate document types before vector/hybrid ranking.

#### Approach
Introduce typed lanes as first-class retrieval metadata and route each query into a bounded lane set prior to scoring. Keep title influence low and weight ranking by lane fitness plus evidence quality. Preserve existing checkpoint/miss-learning controls as the decision plane and add lane routing as the candidate-selection plane. Roll out lane filtering behind explicit guardrails with before/after precision fixtures.

#### Examples / Specifications
Lane taxonomy (v1):

```ts
type RetrievalLane =
	| 'error-runbook'
	| 'fact'
	| 'policy'
	| 'architecture'
	| 'session-log'
	| 'workflow'
```

Lane routing policy sketch:

```text
if query resembles operational error (ERR:, stack trace, incident terms)
	lanes = [error-runbook, fact, policy]

else if query asks broad system overview
	lanes = [fact, architecture, workflow]

else if query asks behavioral precedence/rules
	lanes = [policy, fact]

fallback
	lanes = [fact, architecture, workflow]
```

Ranking priority in lane-aware mode:

```text
finalScore = laneFitnessWeight
					 + evidenceStrengthWeight
					 + semanticScoreWeight
					 + lexicalScoreWeight
					 + hintBoostWeight

titleWeight ~= 0 (non-primary)
```

#### Error Conditions / Edge Cases
- Missing lane metadata on legacy docs: route through deterministic backfill/default lane assignment.
- Ambiguous queries mapping to many lanes: cap lane set size and fallback to conservative defaults.
- Sparse lane corpus: allow controlled lane broadening with checkpoint trace annotation.
- Lane overfitting risk: monitor lane-level precision and rollback via guardrail thresholds.

#### Decisions Made
- ✅ Decided: Lane metadata becomes a required retrieval attribute for scored candidates. -> Rationale: enforce relevance boundaries before ranking.
- ✅ Decided: Runtime routing pre-filters candidates by lane before hybrid/vector scoring. -> Rationale: reduce mixed-category false positives.
- ✅ Decided: Title is non-primary ranking signal in lane-aware mode. -> Rationale: titles may be noisy and should not dominate evidence.

#### Integration Points
- Extends checkpoint orchestration from ticket 072.
- Uses miss-learning and hint infrastructure from ticket 073.
- Uses rollout guardrail framework from ticket 074.
- Implemented by tickets 076, 077, and 078.

#### Validation & Closure
This implementation plan establishes:
- ✅ Typed-lane retrieval architecture and routing strategy are specified.
- ✅ Ranking priorities and low-title-influence policy are specified.
- ✅ Implementation and evaluation work is split into explicit follow-up tickets.

**Ticket 075 is now closed.**
