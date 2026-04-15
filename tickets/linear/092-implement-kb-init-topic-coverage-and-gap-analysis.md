# Implement `kb init` topic coverage and gap analysis

## Ticket ID
092

## Theme
onboarding / quality / decisioning

## Problem

Ticket 090 defines per-topic confidence and sufficiency decisions for `kb init`, but the current bootstrap flow has no structured way to assess whether setup, architecture, workflows, configuration, testing, or release are adequately covered before documents are finalized.

## Scope

- Add topic bucket definitions for init coverage assessment
- Implement structured topic coverage scoring from source docs, user answers, and draft documents
- Implement gap objects that drive follow-up question selection
- Define stop reasons and unresolved/inferred topic outputs

## Acceptance Criteria

- `kb init` produces structured topic coverage assessments
- Weak, missing, or contradictory topics are surfaced deterministically
- Follow-up selection can consume the gap-analysis output directly
- Tests cover sufficient / inferred / unresolved topic outcomes

## Dependencies

- 090
- 091

## Deliverables

- Topic coverage assessment module
- Gap-analysis output schema
- Tests for coverage and sufficiency decisions

## Estimate
M

## Priority
High

---

## Implementation Plan

### Extract topic coverage and gap analysis into a dedicated `kb init` decision module

#### Background
After ticket 091, `kb init` had interview-aware checkpoint state, but its actual confidence logic was still a small inline heuristic embedded in `src/cli/init-cli.ts`. That made it hard to reason about topic sufficiency, contradiction handling, and follow-up selection as a first-class runtime concern.

#### Approach
Move topic coverage assessment into a dedicated module, `src/cli/init-topic-coverage.ts`, and make it own the topic definitions, topic inference, contradiction detection, coverage summaries, and follow-up gap objects. Keep `init-cli.ts` focused on orchestration while the new module decides whether a topic is sufficient, inferred-only, unresolved, or still needs follow-up. Upgrade follow-up planning to consume explicit gap objects with reason codes (`missing-topic`, `low-confidence`, `contradiction`, `needs-example`) instead of deriving everything from a simple score. Add focused tests for grounded sufficiency, contradiction cases, and non-interactive inferred coverage.

#### Examples / Specifications

Implemented module surface:

```ts
assessTopicCoverage(context, candidateDocs, nonInteractive)
buildTopicCoverageGaps(coverage)
summariseCoverage(coverage)
inferTopicFromQuestion(question)
getTopicDefinition(topic)
```

Gap object shape:

```ts
interface TopicCoverageGap {
  topic: InitTopic
  status: 'needs-follow-up' | 'inferred-only' | 'unresolved'
  confidence: 'high' | 'medium' | 'low'
  missingFields: string[]
  evidenceSources: Array<'source-doc' | 'user-answer' | 'model-inference'>
  keyEvidence: string[]
  reason: 'missing-topic' | 'low-confidence' | 'contradiction' | 'needs-example'
  enoughContext: boolean
  contradictorySignals: string[]
}
```

Implemented behavior:

```text
source docs + user answer + draft docs
  -> sufficient / high confidence

conflicting terms across source + answer + docs
  -> unresolved / contradiction

non-interactive weak evidence
  -> inferred-only with explicit stop reason
```

#### Error Conditions / Edge Cases
- Contradictory topic evidence is surfaced explicitly rather than being scored as “good enough.”
- User-answer-only topics can become `needs-example` gaps instead of pretending they are fully grounded.
- Non-interactive runs keep uncertainty visible through `inferred-only` / `unresolved` states.
- Follow-up planning now keys off gap reason codes, making it easier to ask the right next question for contradictions vs missing topics.

#### Decisions Made
- ✅ Decided: Extract coverage logic into `src/cli/init-topic-coverage.ts`. → Rationale: topic decisioning should be testable and reusable, not buried in CLI orchestration.
- ✅ Decided: Represent weak topics as structured gap objects. → Rationale: follow-up selection needs richer inputs than a raw confidence score.
- ✅ Decided: Add contradiction detection for topic-specific opposing signals. → Rationale: a topic with conflicting evidence should not be treated as merely “low confidence.”
- ✅ Decided: Keep the current topic taxonomy from ticket 090. → Rationale: it already matches the onboarding areas we want init to reason about.

#### Integration Points
- Builds directly on ticket 091’s checkpoint/runtime foundation.
- Refactors `src/cli/init-cli.ts` to consume `init-topic-coverage.ts` rather than owning coverage logic inline.
- Sets up ticket 093, where follow-up question rounds and final reporting can become more targeted using the richer gap reasons.

#### Validation & Closure
This implementation establishes:
- ✅ `kb init` now produces structured topic coverage assessments from a dedicated module
- ✅ Weak, missing, inferred, and contradictory topics are surfaced deterministically
- ✅ Follow-up selection can consume explicit gap-analysis output
- ✅ Tests cover sufficient, contradictory, and inferred/unresolved outcomes

Validated with:
- `npx vitest run tests/cli/init-cli.test.ts tests/cli/init-topic-coverage.test.ts`
- `npm run type-check`

**Ticket 092 is now closed.**
