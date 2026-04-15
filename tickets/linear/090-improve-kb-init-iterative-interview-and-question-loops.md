# Improve `kb init` iterative interview and question loops

## Ticket ID
090

## Theme
onboarding / cli-ux / knowledge synthesis

## Problem

`kb init` currently bootstraps a KB from local docs plus a single up-front question pass, but the interview quality is still too shallow for strong project coverage. The implementation in `src/cli/init-cli.ts` asks at most one static batch of heuristic questions during `read-inputs`, then runs three LLM passes with no true confidence-driven follow-up loop.

That creates a few concrete gaps:

1. **Question generation is shallow and mostly keyword-based.** Missing topics are inferred from simple README keyword checks (`install`, `usage`, `architecture`, etc.), not from a richer gap analysis of what the documents still fail to explain.
2. **There is no iterative interview loop.** After the first answers are collected, later passes refine docs but do not pause to ask targeted clarifying questions or sub-questions when coverage is weak.
3. **No structured uncertainty model exists.** The workflow does not persist unresolved topics, confidence bands, missing areas, or rationale for why a follow-up question was asked.
4. **Checkpointing is too thin for multi-round interviews.** The checkpoint stores `sourceFiles`, flat `userAnswers`, and `candidateDocs`, but not interview rounds, pending questions, answered gaps, or coverage status.
5. **Document generation is under-informed.** Generated docs can miss high-level framing, project-specific workflows, constraints, and operational nuance because the system stops asking once the first batch completes.
6. **The workflow has no per-topic stopping logic.** A project may be well-covered for setup but still weak on architecture or release workflows; `kb init` needs to decide “we have enough context here” on a topic-by-topic basis rather than treating the whole project as equally complete or incomplete.

We need `kb init` to behave more like an iterative onboarding interview: inspect source docs, ask focused questions, synthesize draft KB docs, identify weak spots, ask narrower follow-ups, incorporate user feedback, and only then finalize durable docs.

## Scope

- Investigate and specify a richer multi-phase `kb init` interview workflow.
- Add explicit interview rounds, follow-up question generation, and sub-question handling.
- Define how gap detection works between synthesis passes.
- Define checkpoint schema changes needed to resume iterative interviews safely.
- Specify user interaction rules for interactive and non-interactive modes.
- Define safety/termination rules so the question loop stays useful and does not become unbounded.
- Identify follow-up implementation work if this ticket remains planning-only.

## Non-Goals

- Replacing the current `kb init` command with a fully interactive TUI in this ticket.
- Solving retrieval quality or post-init ranking behavior beyond better source-document generation.
- Implementing repository-wide code analysis outside the current init source-document inputs.
- Designing a generalized agent interview engine for all commands; this is specifically about `kb init`.

## Acceptance Criteria

- The ticket defines a concrete iterative interview model for `kb init`.
- The plan distinguishes initial discovery questions from later confidence-driven follow-ups.
- Checkpoint/state requirements are explicit for resumable multi-round interviews.
- Interactive vs non-interactive behavior is documented.
- Exit conditions and guardrails are defined for question loops.
- Follow-up implementation work is identified if the ticket is planning-only.

## Dependencies

- 082
- 071
- 072
- 074

## Deliverables

- Ticket-level design for iterative `kb init` interview rounds
- Proposed checkpoint/state model for question loops
- Gap-analysis and follow-up question strategy
- Follow-up implementation ticket(s) if needed

## Estimate
L

## Priority
High

---

## Investigation Notes / Game Plan

### Current State Observed

The current `kb init` runtime in `src/cli/init-cli.ts` does have a five-cycle structure, but the interview behavior is much simpler than intended:

- `read-inputs` collects source files and asks a single batch of questions
- question generation is done by `generateInitialQuestions()` using coarse keyword checks
- `pass1` synthesizes candidate docs from source files + flat Q/A
- `pass2` refines docs, but does **not** ask new questions
- `pass3` runs quality cleanup only
- checkpoint state stores only:
  - `sourceFiles`
  - `userAnswers`
  - `candidateDocs`

This means the current system has multiple refinement passes, but only one human-feedback phase.

### Proposed Direction

Evolve `kb init` from a single interview prompt set into a **coverage-driven interview loop** with explicit rounds:

1. **Discovery round**
   - Read README / AGENTS / docs
   - Ask foundational questions for known core topics
   - Capture initial project framing

2. **Synthesis round**
   - Generate candidate KB docs
   - Produce a structured coverage report:
     - covered topics
     - weak-confidence topics
     - missing topics
     - suspected contradictions / ambiguity

3. **Follow-up round**
   - Generate targeted clarifying questions only for weak or missing areas
   - Allow sub-questions when an answer is still broad or incomplete
   - Merge answers back into context state

4. **Revision round**
   - Rebuild/refine docs using the expanded interview context
   - Optionally repeat follow-up once more if confidence is still low and loop budget remains

5. **Finalization round**
   - Produce final docs
   - Emit summary of what is well-covered vs what remains inferred or unknown

Under this model, each major topic area gets its own mini-loop and can stop independently once confidence is high enough. Example topic buckets:

- project overview / purpose
- install and setup
- core commands / workflows
- architecture / major components
- configuration
- testing
- deployment / release
- constraints / gotchas / decisions

### Recommended Runtime Shape

Add explicit interview-aware cycles rather than hiding follow-up logic inside generic refinement:

```text
read-inputs
interview-round-1
draft-docs
gap-analysis
interview-round-2
finalize-docs
write
```

Or, if we want to preserve the existing 5-cycle mental model, reinterpret the middle cycles:

```text
read-inputs
pass1 = initial synthesis + coverage report
pass2 = follow-up interview + revision
pass3 = final quality + unresolved-gap summary
write
```

### Key Design Decisions To Drive Implementation

- Use **structured gap objects**, not prose-only reasoning, to decide whether another question round is needed.
- Track **confidence and sufficiency per topic area**, not just globally for the whole init run.
- Cap question rounds with hard budgets:
  - max rounds
  - max questions per round
  - max total questions
- Persist interview state in checkpoint files so resumes do not lose pending follow-ups.
- Distinguish:
  - facts confirmed by source docs
  - facts confirmed by user answers
  - facts inferred by model but not confirmed
- In non-interactive mode, unresolved gaps should become explicit “inferred/unknown” coverage output rather than silently disappearing.

Suggested sufficiency model per topic:

```ts
type TopicCoverageStatus = 'sufficient' | 'needs-follow-up' | 'inferred-only' | 'unresolved'

interface TopicCoverageAssessment {
  topic: string
  confidence: 'high' | 'medium' | 'low'
  status: TopicCoverageStatus
  evidenceSources: Array<'source-doc' | 'user-answer' | 'model-inference'>
  stopReason?:
    | 'enough-grounded-evidence'
    | 'user-confirmed'
    | 'question-budget-exhausted'
    | 'non-interactive-mode'
    | 'still-ambiguous'
}
```

The init loop should only keep drilling into a topic when:

- the topic is important enough to the KB surface,
- grounded evidence is weak or contradictory,
- and the loop still has remaining question budget.

This gives us a much better decision rule than “just ask more questions.”

### Proposed Checkpoint Additions

```ts
interface InitInterviewQuestion {
  id: string
  round: number
  topic: string
  reason: 'missing-topic' | 'low-confidence' | 'contradiction' | 'needs-example'
  question: string
  answer?: string
  askedAt?: string
  answeredAt?: string
}

interface InitCoverageGap {
  topic: string
  status: 'covered' | 'weak' | 'missing' | 'contradictory'
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
  followUpQuestionIds: string[]
  enoughContext: boolean
  stopReason?: string
}
```

Checkpoint evolution:

```ts
interface InitCheckpointV2 {
  version: 2
  completedCycles: InitCycle[]
  context?: InitContext
  candidateDocs?: CandidateDoc[]
  interviewRounds?: Array<{
    round: number
    questions: InitInterviewQuestion[]
  }>
  coverageGaps?: InitCoverageGap[]
  finalCoverageSummary?: {
    coveredTopics: string[]
    inferredTopics: string[]
    unresolvedTopics: string[]
  }
}
```

### Follow-up Implementation Shape

Likely implementation slices:

1. Extract interview/question planning out of `init-cli.ts` into a dedicated init workflow module
2. Add structured gap-analysis pass output
3. Add resumable follow-up question rounds
4. Add per-topic confidence/sufficiency assessment and stop rules
5. Add richer final reporting and tests

This ticket is intended to define that plan cleanly before we change the runtime.

---

## Implementation Plan

### Adopt a topic-aware, confidence-driven interview loop for `kb init`

#### Background
`kb init` already has a multi-cycle shell, but its only user-feedback phase happens once during `read-inputs`. That makes the bootstrap flow brittle: it can synthesize documents from sparse context, but it cannot notice that setup is well-covered while architecture is still vague, or that testing needs one concrete sub-question before the KB is truly useful.

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
  - Define the iterative interview model for `kb init`
  - Define per-topic confidence and sufficiency assessment
  - Define checkpoint/state evolution for resumable question loops
  - Define loop guardrails, stop rules, and non-interactive behavior
- ⏳ Phase 2 (Implementation): Deferred to follow-up tickets
  - 091: implement init interview state machine + checkpoint schema
  - 092: implement gap analysis and topic-confidence assessment
  - 093: implement resumable follow-up questioning and final reporting

#### Approach
Keep `kb init` as a staged CLI workflow, but change its middle stages from “LLM refinement passes” into a structured interview engine. The runtime should synthesize draft documents, score topic coverage, and only ask more questions for specific topics whose evidence is weak, contradictory, or inference-only. Each topic gets its own sufficiency decision so the loop can stop for setup while continuing for architecture or release. The checkpoint becomes interview-aware, allowing init runs to resume with pending topic questions, answered follow-ups, and an explicit final coverage summary.

#### Examples / Specifications

Recommended topic buckets for v1:

```ts
type InitTopic =
  | 'project-overview'
  | 'install-setup'
  | 'core-workflows'
  | 'architecture'
  | 'configuration'
  | 'testing'
  | 'deployment-release'
  | 'constraints-gotchas'
```

Topic-level assessment:

```ts
type TopicCoverageStatus = 'sufficient' | 'needs-follow-up' | 'inferred-only' | 'unresolved'

interface TopicCoverageAssessment {
  topic: InitTopic
  confidence: 'high' | 'medium' | 'low'
  status: TopicCoverageStatus
  evidenceSources: Array<'source-doc' | 'user-answer' | 'model-inference'>
  keyEvidence: string[]
  missingFields: string[]
  stopReason?:
    | 'enough-grounded-evidence'
    | 'user-confirmed'
    | 'question-budget-exhausted'
    | 'non-interactive-mode'
    | 'still-ambiguous'
}
```

Interview-aware checkpoint shape:

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

interface InitCheckpointV2 {
  version: 2
  updatedAt: string
  baseName: string
  workingDir: string
  completedCycles: InitCycle[]
  context?: InitContext
  candidateDocs?: CandidateDoc[]
  interviewRounds?: Array<{
    round: number
    questions: InitInterviewQuestion[]
  }>
  topicCoverage?: TopicCoverageAssessment[]
  finalCoverageSummary?: {
    coveredTopics: InitTopic[]
    inferredTopics: InitTopic[]
    unresolvedTopics: InitTopic[]
  }
}
```

Recommended runtime lifecycle:

```text
Cycle 1: read-inputs
  - collect README / AGENTS / docs
  - seed initial topic map
  - ask foundational questions

Cycle 2: pass1
  - synthesize draft docs
  - emit topic coverage assessment

Cycle 3: pass2
  - ask follow-up questions only for topics marked needs-follow-up / unresolved
  - support narrower sub-questions when needed
  - revise draft docs

Cycle 4: pass3
  - finalize docs
  - emit explicit unresolved/inferred coverage summary

Cycle 5: write
  - write docs and persist final init summary
```

Interactive example:

```text
[kb init] Topic: architecture
Current confidence: low
Reason: source docs name components but do not explain how they relate.

> What are the main components of the system, and how do they interact at a high level?

[kb init] Topic: testing
Current confidence: sufficient
No follow-up needed.
```

Non-interactive output expectation:

```json
{
  "status": "accepted",
  "mode": "non-interactive",
  "writtenDocIds": ["project-overview", "installation-and-configuration"],
  "coverage": {
    "coveredTopics": ["project-overview", "install-setup"],
    "inferredTopics": ["configuration"],
    "unresolvedTopics": ["deployment-release", "constraints-gotchas"]
  }
}
```

#### Error Conditions / Edge Cases
- No source files found: still run the interview, but seed from a fallback topic questionnaire and mark all early coverage as user-answer-derived.
- User skips a question: preserve the unanswered question in checkpoint state and downgrade topic confidence rather than pretending the topic is covered.
- Question budget exhausted: stop asking, finalize docs, and mark affected topics with `stopReason: question-budget-exhausted`.
- Non-interactive mode: never synthesize fake certainty; unresolved topics must remain explicit in final coverage output.
- Contradictory evidence between source docs and user answers: mark the topic as `unresolved` or `needs-follow-up` until a clarifying answer is captured or the loop budget expires.
- Resume from checkpoint after partial interview: only ask pending or newly-generated follow-ups; do not repeat already-answered questions.
- Broad answers that still lack specifics: allow a second-round sub-question for the same topic, but cap follow-up depth to avoid unbounded interviews.

#### Decisions Made
- ✅ Decided: Use topic-aware interview loops rather than one global “ask more questions” loop. → Rationale: `kb init` needs to stop independently for topics that are already well-grounded while continuing only where evidence is weak.
- ✅ Decided: Make confidence/sufficiency a first-class checkpointed state object. → Rationale: the runtime needs a durable basis for resume behavior and “do we have enough context?” decisions.
- ✅ Decided: Preserve the existing 5-cycle user-facing mental model while changing the meaning of middle passes. → Rationale: smaller CLI surface change, lower implementation risk, easier migration from current `init-cli.ts`.
- ✅ Decided: Surface unresolved and inference-only topics explicitly in final output. → Rationale: hidden uncertainty creates low-quality KB documents and false confidence.
- ✅ Decided: Treat question budgets as hard guardrails. → Rationale: interactive init should stay useful and bounded, not become an endless interview.

#### Integration Points
- Extends ticket 082’s `kb init` bootstrap flow rather than replacing it.
- Reuses the staged decision/checkpoint ideas from tickets 071, 072, and 074, but applies them to onboarding interview quality instead of retrieval.
- Implementation should likely extract the current interview logic from `src/cli/init-cli.ts` into dedicated init workflow modules.
- Follow-up tickets:
  - 091 implements checkpoint/state evolution and the interview state machine
  - 092 implements topic coverage scoring and gap analysis
  - 093 implements interactive follow-up rounds, sub-questions, and final coverage reporting

#### Validation & Closure
This implementation plan establishes:
- ✅ A concrete iterative interview model for `kb init`
- ✅ A clear distinction between initial discovery questions and later confidence-driven follow-ups
- ✅ Explicit checkpoint/state requirements for resumable multi-round interviews
- ✅ Defined interactive and non-interactive behavior
- ✅ Defined exit conditions, question budgets, and per-topic stop rules
- ✅ Explicit follow-up tickets for deferred implementation work

**Ticket 090 is now closed.**
