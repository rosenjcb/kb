# Implement `kb init` interview state machine and checkpoint schema

## Ticket ID
091

## Theme
onboarding / runtime / checkpoints

## Problem

Ticket 090 defines a topic-aware, confidence-driven interview loop for `kb init`, but the current runtime in `src/cli/init-cli.ts` only persists flat source files, flat user answers, and candidate docs. There is no interview state machine, no round-aware checkpoint model, and no durable state for pending or answered follow-up questions.

## Scope

- Add `InitCheckpointV2` and migration/compatibility behavior from the current checkpoint shape
- Introduce interview rounds and pending-question state into `kb init`
- Refactor init workflow control flow so question rounds and synthesis passes can resume safely
- Preserve current CLI command surface while updating internal cycle semantics

## Acceptance Criteria

- `kb init` checkpoint state persists interview rounds and topic-aware pending questions
- Resume behavior does not re-ask answered questions
- State machine cleanly supports initial and follow-up interview rounds
- Tests cover checkpoint persistence and resume semantics

## Dependencies

- 090
- 082

## Deliverables

- Updated init checkpoint schema
- Refactored init orchestration/state machine
- Tests for checkpointed interview behavior

## Estimate
L

## Priority
High

---

## Implementation Plan

### Ship an interview-aware `kb init` checkpoint model with resumable rounds

#### Background
Ticket 090 defined the new `kb init` direction, but the runtime still persisted only a flat context plus candidate docs. That was not enough to support resumable initial/follow-up interviews, topic-aware question state, or migration from the earlier checkpoint format.

#### Approach
Upgrade `src/cli/init-cli.ts` to use `InitCheckpointV2` as the canonical persisted format and migrate older v1 checkpoints on read. Add interview-round state, topic-aware question metadata, coverage assessments, and final coverage summary fields to the checkpoint. Refactor the runtime so `read-inputs` stores an initial interview round, `pass1` persists coverage-aware draft state, and `pass2` can resume into a follow-up interview without re-asking already answered questions. Keep the CLI contract unchanged while making the internal init lifecycle interview-aware and testable through injected provider/question IO hooks.

#### Examples / Specifications

Implemented checkpoint structure:

```ts
interface InitCheckpoint {
  version: 2
  updatedAt: string
  baseName: string
  workingDir: string
  completedCycles: InitCycle[]
  context?: InitContext
  candidateDocs?: CandidateDoc[]
  interviewRounds?: InitInterviewRound[]
  topicCoverage?: TopicCoverageAssessment[]
  finalCoverageSummary?: InitCoverageSummary
}
```

Implemented round/question state:

```ts
interface InitInterviewQuestion {
  id: string
  round: number
  topic: InitTopic
  reason: 'missing-topic' | 'low-confidence' | 'contradiction' | 'needs-example'
  question: string
  answer?: string
  askedAt?: string
  answeredAt?: string
}
```

Resume behavior:

```text
v1 checkpoint
  -> migrate on read
  -> preserve prior answers as interview round 1
  -> do not re-ask old questions
  -> continue with pass1/pass2 using v2 checkpoint writes
```

#### Error Conditions / Edge Cases
- Old checkpoint shape is accepted and migrated to v2 during `readCheckpoint`.
- Resumed runs do not re-ask questions already present in prior interview rounds.
- Non-interactive runs persist coverage state without attempting to ask follow-up questions.
- If question budget is exhausted, later rounds are skipped and topic coverage remains explicit in checkpoint state.

#### Decisions Made
- ✅ Decided: Make v2 checkpoint migration happen transparently at read time. → Rationale: old init runs should resume safely without a separate migration step.
- ✅ Decided: Inject question IO and provider hooks into `runKbInit`. → Rationale: makes pause/resume interview behavior testable without changing CLI usage.
- ✅ Decided: Persist interview rounds directly instead of deriving them from flat answers later. → Rationale: rounds are part of the runtime state machine, not just reporting sugar.
- ✅ Decided: Preserve the existing `read-inputs/pass1/pass2/pass3/write` cycle names. → Rationale: smaller surface change while enabling the new internal interview flow.

#### Integration Points
- Implements the first runtime slice from ticket 090.
- Creates the foundation needed for ticket 092 topic coverage scoring and ticket 093 richer follow-up/reporting behavior.
- Main code lives in `src/cli/init-cli.ts`; focused coverage lives in `tests/cli/init-cli.test.ts`.

#### Validation & Closure
This implementation establishes:
- ✅ `kb init` checkpoint state now persists interview rounds and topic-aware checkpoint metadata
- ✅ Resume behavior avoids re-asking already answered questions
- ✅ The init runtime supports initial and follow-up interview rounds through one checkpointed state machine
- ✅ Tests cover checkpoint persistence, resume behavior, and v1→v2 migration

Validated with:
- `npx vitest run tests/cli/init-cli.test.ts`
- `npm run type-check`

**Ticket 091 is now closed.**
