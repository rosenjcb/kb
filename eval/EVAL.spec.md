---
type: Spec
title: "Spec: MOEL Evaluation Framework"
sources: [./]
tests:
  - ../tests/eval
  - ../tests/eval-run.test.ts
  - ../tests/eval-server.test.ts
description: Behavioral specification for MOEL Evaluation Framework
tags: [spec, kb, multi-base]
timestamp: 2026-08-02T23:10:00Z
---

### Intro

Behavioral requirements. Architecture: [EVAL.md](EVAL.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- See related companion docs for architectural boundaries

### Functional Requirements

| ID | Requirement |
| ------ | ------------ |
| FR-1 | Behaviors in ast-loss.test.ts |
| FR-2 | Behaviors in compaction.test.ts |
| FR-3 | Behaviors in control-core.test.ts |
| FR-4 | Behaviors in eval-score.test.ts |
| FR-5 | Behaviors in filesystem-tools.test.ts |
| FR-6 | Behaviors in jury-loss.test.ts |
| FR-7 | Behaviors in manifest-validator.test.ts |
| FR-8 | Behaviors in moel.test.ts |
| FR-9 | Behaviors in relevance-loss.test.ts |
| FR-10 | Behaviors in resource-loss.test.ts |
| FR-11 | Behaviors in summary.test.ts |
| FR-12 | Behaviors in trajectory-loss.test.ts |
| FR-13 | Behaviors in eval-run.test.ts |
| FR-14 | [REMOVED] Behaviors in eval-snapshot.test.ts — agent-compare-eval skill retired, folded into kb:evaluation-run |
| FR-15 | [REMOVED] Behaviors in eval-task-artifact.test.ts — agent-compare-eval skill retired, folded into kb:evaluation-run |
| FR-16 | Multi-suite harvest shares one multi-base kb-server by default: children keep `KB_EVAL_SERVER_URL`, select `eval-{suite}` via `--base` / `X-KB-Base`, probe `/healthz?base=`; `--per-suite-server` restores ephemeral per-child servers; `--skip-scan` is forwarded to children |
| FR-17 | `--from-snapshot` adopts the published Fly.io snapshot for the suite (download → verify → `kb-server import` into the eval base) instead of indexing locally: it implies `--skip-scan`, cancels `--force-init` so the adopted index is never wiped, records `command_durations_ms.snapshot_pull`, and is forwarded to multi-suite children |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-1 | FR-1 | Given identical snippets, returns 0.0 | pass |
| TC-2 | FR-1 | Given completely disjoint named exports, returns 1.0 | pass |
| TC-3 | FR-1 | Given one extra export in candidate, returns partial loss | pass |
| TC-4 | FR-1 | Given unsupported language, returns 1.0 | pass |
| TC-5 | FR-1 | Given interface declaration, it is included in the node set | pass |
| TC-6 | FR-1 | Given identical Python snippets, returns 0.0 | pass |
| TC-7 | FR-1 | Given Python snippets with one missing function, returns partial loss | pass |
| TC-8 | FR-2 | returns triggered: false | pass |
| TC-9 | FR-2 | returns an empty events array | pass |
| TC-10 | FR-2 | returns a new object each call (not shared reference) | pass |
| TC-11 | FR-2 | returned object satisfies CompactionRecord type shape | pass |
| TC-12 | FR-2 | accepts all valid condition values | pass |
| TC-13 | FR-3 | default Claude Code argv loads no kb/MCP (--strict-mcp-config) | pass |
| TC-14 | FR-3 | describeAgentCommand prefers an explicit agent-cmd override | pass |
| TC-15 | FR-3 | defaultCursorArgv uses read-only ask mode with json output | pass |
| TC-16 | FR-3 | accepts claude and cursor | pass |
| TC-17 | FR-3 | throws on unknown backends | pass |
| TC-18 | FR-3 | resolves the agent binary (claude by default, cursor → agent, else agent-cmd) | pass |
| TC-19 | FR-3 | throws an actionable error naming the missing binary and --skip-control | pass |
| TC-20 | FR-3 | throws when the control prompt lacks {{question}} | pass |
| TC-21 | FR-3 | passes for an available binary with a valid prompt | pass |
| TC-22 | FR-3 | shows tokens and duration for Cursor-style telemetry | pass |
| TC-23 | FR-3 | shows turns and cost for Claude-style telemetry | pass |
| TC-24 | FR-3 | reads Cursor Agent CLI camelCase usage fields | pass |
| TC-25 | FR-3 | parses the trailing JSON object even with a leading banner | pass |
| TC-26 | FR-3 | throws when there is no JSON object | pass |
| TC-27 | FR-3 | runs the agent per question and builds a scored control block | pass |
| TC-28 | FR-3 | returns partial when the agent fails on some questions | pass |
| TC-29 | FR-3 | throws when the control prompt lacks the {{question}} placeholder | pass |
| TC-30 | FR-3 | returns complete_unscored when agent answers succeed but auto-score throws | pass |
| TC-31 | FR-3 | computes kb-minus-control deltas per axis | pass |
| TC-32 | FR-3 | reads a control JSON result (the __control__ sentinel) | pass |
| TC-33 | FR-3 | falls back to kb-query text parsing for non-control files | pass |
| TC-34 | FR-3 | tags control vs kb artifacts | pass |
| TC-35 | FR-4 | returns the result immediately when the fn succeeds on the first attempt | pass |
| TC-36 | FR-4 | retries and succeeds on a later attempt | pass |
| TC-37 | FR-4 | throws the last error after exhausting all attempts | pass |
| TC-38 | FR-4 | does not retry on success even with attempts > 1 | pass |
| TC-39 | FR-4 | every rubric axis defines five labels mapping onto ordinal levels 0–4 | pass |
| TC-40 | FR-4 | scoreFromLabel resolves a known label to its ordinal level | pass |
| TC-41 | FR-4 | scoreFromLabel tolerates casing, spaces, and hyphens | pass |
| TC-42 | FR-4 | scoreFromLabel falls back to the legacy numeric path | pass |
| TC-43 | FR-4 | scoreFromLabel returns 0 for an unrecognized verdict | pass |
| TC-44 | FR-4 | the rubric instructs the judge to pick labels, not numbers | pass |
| TC-45 | FR-4 | parses a top-level JSON array from judge output | pass |
| TC-46 | FR-4 | scores more than SCORE_BATCH_SIZE questions in multiple judge batches | pass |
| TC-47 | FR-5 | returns content and length for an existing file | pass |
| TC-48 | FR-5 | returns an error for a non-existent file | pass |
| TC-49 | FR-5 | reads an empty file without error | pass |
| TC-50 | FR-5 | reads multiline content correctly | pass |
| TC-51 | FR-5 | returns sorted entries for an existing directory | pass |
| TC-52 | FR-5 | returns an empty array for an empty directory | pass |
| TC-53 | FR-5 | includes subdirectory names | pass |
| TC-54 | FR-5 | returns an error for a non-existent path | pass |
| TC-55 | FR-5 | returns matching lines for a literal pattern | pass |
| TC-56 | FR-5 | is case-insensitive | pass |
| TC-57 | FR-5 | supports regex patterns | pass |
| TC-58 | FR-5 | falls back to literal match for invalid regex | pass |
| TC-59 | FR-5 | returns empty array when no lines match | pass |
| TC-60 | FR-5 | returns contentLengthChars | pass |
| TC-61 | FR-5 | returns an error for a non-existent file | pass |
| TC-62 | FR-5 | dispatches read_file | pass |
| TC-63 | FR-5 | dispatches list_directory | pass |
| TC-64 | FR-5 | dispatches search_file_contents | pass |
| TC-65 | FR-5 | has exactly three tool definitions | pass |
| TC-66 | FR-5 | each definition has name, description, and schema | pass |
| TC-67 | FR-5 | includes the repo path in the prompt | pass |
| TC-68 | FR-5 | wraps output in filesystem-tools tags | pass |
| TC-69 | FR-5 | includes tool names in the JSON | pass |
| TC-70 | FR-6 | Returns null for invalid JSON | pass |
| TC-71 | FR-6 | Returns null when analysis is empty | pass |
| TC-72 | FR-6 | Returns null when veto_flag is missing | pass |
| TC-73 | FR-6 | Returns parsed verdict for valid input | pass |
| TC-74 | FR-6 | All judges agree with score 5 → loss = 0 | pass |
| TC-75 | FR-6 | All judges score 0 → loss = 1 | pass |
| TC-76 | FR-6 | One judge vetoes, 2 do not → not vetoed (count < threshold) | pass |
| TC-77 | FR-6 | Two judges veto → L_jury = 1.0, vetoed = true | pass |
| TC-78 | FR-6 | Malformed JSON → counts as veto; two malformed judges → L_jury = 1.0 | pass |
| TC-79 | FR-6 | biasConfig omitted entirely → DEFAULT_BIAS_CONFIG applied, no runtime error | pass |
| TC-80 | FR-6 | Mixed scores produce expected L_jury (no biases) | pass |
| TC-81 | FR-6 | raw score 5 on 1000-token candidate → adjustedScore ≈ 0.724 | pass |
| TC-82 | FR-6 | Normalization off → adjustedScores equal raw scores | pass |
| TC-83 | FR-6 | forward=5, reversed=1 → averaged=3, warning emitted | pass |
| TC-84 | FR-6 | forward=5, reversed=4 → averaged=4.5, no consistency warning | pass |
| TC-85 | FR-6 | positionConsistencyDelta absent when debiasing is off | pass |
| TC-86 | FR-6 | openai judge with generatorProviderName=openai → weight=0.5, warning emitted | pass |
| TC-87 | FR-6 | Down-weighted judge still contributes its veto count (Example D) | pass |
| TC-88 | FR-6 | Weighted mean correctly down-weights self-enhancement judge (Example C) | pass |
| TC-89 | FR-6 | Two openai judges + generator=anthropic → throws (only 1 distinct non-generator family) | pass |
| TC-90 | FR-6 | openai + gemini judges + generator=anthropic → does not throw | pass |
| TC-91 | FR-6 | enforceModelFamilyDiversity=false → skips diversity check even with same-family judges | pass |
| TC-92 | FR-7 | returns empty array for empty string | pass |
| TC-93 | FR-7 | returns empty array when no manifest block present | pass |
| TC-94 | FR-7 | extracts files from a fenced JSON block with manifest key | pass |
| TC-95 | FR-7 | handles deleted-only manifest | pass |
| TC-96 | FR-7 | combines modified, created, deleted in that order | pass |
| TC-97 | FR-7 | filters out blank entries | pass |
| TC-98 | FR-7 | trims whitespace from file paths | pass |
| TC-99 | FR-7 | inline fallback returns empty for nested JSON (lazy regex stops at first inner }) | pass |
| TC-100 | FR-7 | prefers fenced block over inline JSON when both present | pass |
| TC-101 | FR-7 | returns empty array when JSON is invalid | pass |
| TC-102 | FR-7 | returns empty array when JSON lacks manifest key | pass |
| TC-103 | FR-7 | handles non-array values in manifest fields gracefully | pass |
| TC-104 | FR-7 | passes when declared matches actual changes | pass |
| TC-105 | FR-7 | fails when an actual change is not declared | pass |
| TC-106 | FR-7 | passes with phantom declaration (declared but not changed) | pass |
| TC-107 | FR-7 | passes with no changes and empty manifest | pass |
| TC-108 | FR-7 | reports declared and actual on the result | pass |
| TC-109 | FR-8 | Given all zero losses, lMoel = 0 | pass |
| TC-110 | FR-8 | Given all maximum losses, lMoel = 1 | pass |
| TC-111 | FR-8 | lCorrectness equals lJury | pass |
| TC-112 | FR-8 | Given weights that do not sum to 1, throws with sum in message | pass |
| TC-113 | FR-8 | Given a negative weight, throws | pass |
| TC-114 | FR-8 | Given a loss component outside [0,1], throws | pass |
| TC-115 | FR-8 | Result serializes to JSON with no undefined values | pass |
| TC-116 | FR-8 | taskId and condition are set on the result | pass |
| TC-117 | FR-8 | Given N > K, hypothesisConfirmed is true and N-K delta is positive | pass |
| TC-118 | FR-8 | Given K > N, hypothesisConfirmed is false | pass |
| TC-119 | FR-8 | Given only K condition, hypothesisConfirmed is false | pass |
| TC-120 | FR-8 | Three conditions produce all pairwise entries | pass |
| TC-121 | FR-9 | Given a relevance arg, then quality averages three axes (back-compat without it) | pass |
| TC-122 | FR-9 | Given an off-topic-but-correct answer, then success_score is lower than a focused one | pass |
| TC-123 | FR-9 | Given no relevance, then success_score matches the legacy two-axis quality | pass |
| TC-124 | FR-9 | Given the rubric, then it scores a Relevance axis and requires it in the schema | pass |
| TC-125 | FR-9 | Given a retrieval detail with a curation segment, then it parses kept/dropped | pass |
| TC-126 | FR-9 | Given details without curation, then parse returns null and summary is null | pass |
| TC-127 | FR-9 | Given several curated details, then it aggregates retrieval precision | pass |
| TC-128 | FR-9 | Given the new fields, then scoreMetric reads relevance and the strict pass gate | pass |
| TC-129 | FR-9 | Given only the legacy pass field, then scoreMetric falls back to it | pass |
| TC-130 | FR-10 | Given zero tokens, returns loss = 0 and weightedTotal = 0 | pass |
| TC-131 | FR-10 | Given exactly at budget (fresh only), returns loss = 1.0 | pass |
| TC-132 | FR-10 | Given tokens far above budget, loss is clamped at 1.0 | pass |
| TC-133 | FR-10 | Cached-heavy run has lower loss than fresh-heavy run with same raw total | pass |
| TC-134 | FR-10 | Given delta = 0, cached tokens contribute nothing to weightedTotal | pass |
| TC-135 | FR-10 | Breakdown fields are summed correctly across multiple steps | pass |
| TC-136 | FR-10 | Result budget field reflects the budget passed in | pass |
| TC-137 | FR-11 | includes run name and suite in header | pass |
| TC-138 | FR-11 | renders task id in the table | pass |
| TC-139 | FR-11 | shows positive N-K delta when N > K | pass |
| TC-140 | FR-11 | shows hypothesisConfirmed: true when N > K for all tasks | pass |
| TC-141 | FR-11 | shows hypothesisConfirmed: false when K >= N for any task | pass |
| TC-142 | FR-11 | renders aggregate row | pass |
| TC-143 | FR-11 | shows dash for null lMoel values | pass |
| TC-144 | FR-11 | contains correct number of table separator rows | pass |
| TC-145 | FR-11 | returns correct runName and suite | pass |
| TC-146 | FR-11 | hypothesisConfirmed is true when N > K for all tasks | pass |
| TC-147 | FR-11 | hypothesisConfirmed is false when K > N for any task | pass |
| TC-148 | FR-11 | taskRows have correct lMoel values | pass |
| TC-149 | FR-11 | nKDelta is N minus K | pass |
| TC-150 | FR-11 | nKDelta is null when either N or K is missing | pass |
| TC-151 | FR-11 | per-task hypothesisConfirmed is null when either condition is missing | pass |
| TC-152 | FR-11 | aggregate meanLMoelByCondition is mean across tasks | pass |
| TC-153 | FR-11 | aggregate nKDelta is mean N minus mean K | pass |
| TC-154 | FR-11 | handles empty tasks array without throwing | pass |
| TC-155 | FR-11 | terminated conditions show lMoel null and terminated true | pass |
| TC-156 | FR-12 | Given an empty trajectory, returns 0 | pass |
| TC-157 | FR-12 | Given 5 unique steps within limit, returns expected combined loss | pass |
| TC-158 | FR-12 | Given same tool called 5 times with identical args, returns high redundancy | pass |
| TC-159 | FR-12 | Given step count at ceiling, step component equals 1.0 | pass |
| TC-160 | FR-12 | Given step count exceeding ceiling, loss is clamped at 1.0 | pass |
| TC-161 | FR-12 | Same tool with different args does not count as duplicate | pass |
| TC-162 | FR-13 | lowercases and replaces non-alphanumeric with hyphens | pass |
| TC-163 | FR-13 | trims leading and trailing hyphens | pass |
| TC-164 | FR-13 | truncates to 48 chars | pass |
| TC-165 | FR-13 | returns "repo" for empty input | pass |
| TC-166 | FR-13 | extracts leaf from https URL | pass |
| TC-167 | FR-13 | extracts leaf from git@ SCP URL | pass |
| TC-168 | FR-13 | strips .git suffix | pass |
| TC-169 | FR-13 | falls back to "repo" for invalid URL | pass |
| TC-170 | FR-13 | prefixes with eval- | pass |
| TC-171 | FR-13 | sanitizes the suite id | pass |
| TC-172 | FR-13 | parses entities and relationships | pass |
| TC-173 | FR-13 | returns 0 for missing counts | pass |
| TC-174 | FR-13 | extracts the final answer, not the first partial one | pass |
| TC-175 | FR-13 | extracts result count from matches line | pass |
| TC-176 | FR-13 | extracts provenance from sources line | pass |
| TC-177 | FR-13 | extracts retrieval method | pass |
| TC-178 | FR-13 | returns null answer when no --- separator found | pass |
| TC-179 | FR-13 | extracts direct answer before --- when no stage> answer lines (one-shot synthesis) | pass |
| TC-180 | FR-13 | strips prefix before first { | pass |
| TC-181 | FR-13 | passes through text that starts with { | pass |
| TC-182 | FR-13 | returns trimmed text when no { present | pass |
| TC-183 | FR-13 | returns coverage_ratio between 0 and 1 | pass |
| TC-184 | FR-13 | returns full coverage when answer contains all facets | pass |
| TC-185 | FR-13 | handles empty question gracefully | pass |
| TC-186 | FR-13 | extracts usefulness from query scores | pass |
| TC-187 | FR-13 | extracts correctness | pass |
| TC-188 | FR-13 | extracts pass_rate | pass |
| TC-189 | FR-13 | extracts success_score | pass |
| TC-190 | FR-13 | falls back to combined when query is absent | pass |
| TC-191 | FR-13 | returns null when key is absent | pass |
| TC-192 | FR-13 | weights default to 0.6 quality / 0.3 tokens / 0.1 speed summing to 1 | pass |
| TC-193 | FR-13 | maps perfect quality, zero tokens, zero time to 1.0 | pass |
| TC-194 | FR-13 | blends the three components with the configured weights | pass |
| TC-195 | FR-13 | clamps token and speed sub-scores to 0 when over budget | pass |
| TC-196 | FR-13 | returns null success_score when telemetry is missing | pass |
| TC-197 | FR-13 | weights cache reads at the MOEL discount when scoring control telemetry | pass |
| TC-198 | FR-13 | treats rubric scores at τ as adequate with diminishing returns above | pass |
| TC-199 | FR-13 | reports ahead when kb success exceeds control by >= 0.02 | pass |
| TC-200 | FR-13 | reports behind when kb success trails control by >= 0.02 | pass |
| TC-201 | FR-13 | reports on par within the 0.02 band | pass |
| TC-202 | FR-13 | extracts docs count | pass |
| TC-203 | FR-13 | extracts entities | pass |
| TC-204 | FR-13 | computes avg_results across query_evaluation | pass |
| TC-205 | FR-13 | returns null when absent | pass |
| TC-206 | FR-13 | matches exact run.suite field | pass |
| TC-207 | FR-13 | returns true for empty suite (no filter) | pass |
| TC-208 | FR-13 | falls back to id match when run.suite is absent | pass |
| TC-209 | FR-13 | formats signed deltas | pass |
| TC-210 | FR-13 | returns dash for null | pass |
| TC-211 | FR-13 | formats large counts compactly | pass |
| TC-212 | FR-13 | formats seconds and minutes | pass |
| TC-213 | FR-13 | reports behind when all axes lose | pass |
| TC-214 | FR-13 | reports ahead when all axes tie or win | pass |
| TC-215 | FR-13 | returns largest negative gaps first | pass |
| TC-216 | FR-13 | returns empty string for empty input | pass |
| TC-217 | FR-13 | returns all mid-char for flat input | pass |
| TC-218 | FR-13 | returns a string of the right length for varied input | pass |
| TC-219 | FR-13 | filters logs by eval base with a generous limit | pass |
| TC-220 | FR-13 | finds the latest init run id | pass |
| TC-221 | FR-13 | finds the latest scan run id | pass |
| TC-222 | FR-13 | returns null when command is absent | pass |
| TC-223 | FR-13 | maps kb condition to K and control to N | pass |
| TC-224 | FR-13 | writes LaTeX macros from scored artifacts | pass |
| TC-225 | FR-14 | [REMOVED] parses valid codeburn status JSON | n/a |
| TC-226 | FR-14 | [REMOVED] throws on malformed JSON | n/a |
| TC-227 | FR-15 | [REMOVED] computes today delta when no midnight crossing | n/a |
| TC-228 | FR-15 | [REMOVED] falls back to month delta when today delta is negative (midnight crossing) | n/a |
| TC-229 | FR-15 | [REMOVED] rounds cost delta to 4 decimal places | n/a |
| TC-230 | FR-15 | [REMOVED] builds artifact with correct structure | n/a |
| TC-231 | FR-15 | [REMOVED] sets base to null for raw agent | n/a |
| TC-232 | FR-15 | [REMOVED] generates correct path | n/a |
| TC-233 | FR-13 | classifyStageTokens splits thinking (:llm) from synthesis (:answer-enrichment) | pass |
| TC-234 | FR-13 | parseRetrievalDetailTrace lifts loop counters from a retrieval detail line | pass |
| TC-235 | FR-13 | buildQuestionTimeline joins stages with the trace and derives retrieval_ms | pass |
| TC-236 | FR-13 | buildQuestionTimeline falls back to the detail string when report.retrieval is absent | pass |
| TC-237 | FR-13 | buildTimelineSummary aggregates shares and flags a thinking-dominant run | pass |
| TC-238 | FR-16 | buildMultiSuiteChildEnv keeps shared multi-base attach URL by default | pass |
| TC-239 | FR-16 | buildMultiSuiteChildEnv strips attach pins in --per-suite-server mode | pass |
| TC-240 | FR-16 | buildChildArgv forwards --skip-scan | pass |
| TC-241 | FR-16 | healthzUrl appends ?base= for multi-base probes | pass |
| TC-242 | FR-16 | buildKbRemoteEnv carries KB_BASE for X-KB-Base | pass |
| TC-243 | FR-13 | reuses an existing session when docs are present | pass |
| TC-244 | FR-13 | force-init wipes the base and runs a full init | pass |
| TC-245 | FR-13 | missing docs still triggers init without a wipe | pass |
| TC-246 | FR-13 | runReportToAnswerTelemetry maps RunReport fields | pass |
| TC-247 | FR-13 | formatAnswerTelemetryLog matches control-style kb query lines | pass |
| TC-248 | FR-13 | readLatestKbQueryRunReport returns newest query for base | pass |
| TC-249 | FR-16 | buildKbRemoteEnv decomposes a url into KB_HOST/KB_PORT/KB_SSLMODE and sets KB_BASE | pass |
| TC-250 | FR-16 | allocateFreePort returns a positive integer | pass |
| TC-251 | FR-16 | DEFAULT_KB_SERVER_PORT is 38117 | pass |
| TC-252 | FR-16 | buildKbRemoteEnv passes through host and default port | pass |
| TC-253 | FR-16 | buildEvalOfflineEnv clears remote connection vars | pass |
| TC-254 | FR-16 | allocateFreePort yields distinct ports for concurrent callers | pass |
| TC-255 | FR-17 | buildChildArgv forwards --from-snapshot to every multi-suite child | pass |

### Related docs

- [EVAL.md](EVAL.md)
- [SERVER.md](../packages/kb-server/src/SERVER.md) (multi-base registry)
- [CONNECTION.md](../packages/kb-client/src/api/CONNECTION.md) (`X-KB-Base`)

