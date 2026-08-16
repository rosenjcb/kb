---
type: Spec
title: "Spec: MOEL Evaluation Framework"
sources: [./]
tests:
  - ../tests/eval
  - ../tests/eval-run.test.ts
  - ../tests/eval-server.test.ts
  - ../tests/eval-task.test.ts
description: Behavioral specification for MOEL Evaluation Framework
tags: [spec, kb, multi-base]
timestamp: 2026-08-16T00:35:00Z
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
| FR-13 | Behaviors in eval-run.test.ts; `--force-init` wipes `~/.kb/sessions/<base>` on disk (not via `kb base delete`) before offline `eval-index` init |
| FR-14 | [REMOVED] Behaviors in eval-snapshot.test.ts — agent-compare-eval skill retired, folded into kb:evaluation-run |
| FR-15 | [REMOVED] Behaviors in eval-task-artifact.test.ts — agent-compare-eval skill retired, folded into kb:evaluation-run |
| FR-16 | Multi-suite harvest shares one long-lived multi-base kb-server: the parent boots placeholder default base `_eval-batch` (not an `eval-{suite}`), children keep `KB_EVAL_SERVER_URL`, select `eval-{suite}` via `--base` / `X-KB-Base`, probe `/healthz?base=`; the server stays up for the whole batch and is never restarted per suite; the eval server env scrubs operator `KB_GIT_REPOS` / `KB_BASE`; `--skip-scan` is forwarded to children |
| FR-17 | `--from-snapshot` adopts the published Fly.io snapshot for the suite (download → verify → `kb-server import` into the eval base) instead of indexing locally: it implies `--skip-scan`, cancels `--force-init` so the adopted index is never wiped, records `command_durations_ms.snapshot_pull`, and is forwarded to multi-suite children |
| FR-18 | `scripts/eval-task.mjs` (`pnpm run eval:task`) runs a real coding task twice in isolated clones pinned to the same commit — kb arm (MCP + kb:dev-workflow skill inlined, base forced) vs control arm (no MCP/kb tools, full Edit/Write/commit access) — with the identical verbatim task prompt (from `eval/tasks/<id>.yaml` or `--issue`/`--prompt-file`), then inspects each clone's git state for whether it committed and writes a `TASK_EVALUATION.md`-schema artifact; no correctness judging, cost/completion only |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-PL8C | FR-1 | Given identical snippets, returns 0.0 | pass |
| TC-DNPN | FR-1 | Given completely disjoint named exports, returns 1.0 | pass |
| TC-5MJS | FR-1 | Given one extra export in candidate, returns partial loss | pass |
| TC-HN5C | FR-1 | Given unsupported language, returns 1.0 | pass |
| TC-NMCE | FR-1 | Given interface declaration, it is included in the node set | pass |
| TC-TMM6 | FR-1 | Given identical Python snippets, returns 0.0 | pass |
| TC-2PSJ | FR-1 | Given Python snippets with one missing function, returns partial loss | pass |
| TC-F71U | FR-2 | returns triggered: false | pass |
| TC-7TIB | FR-2 | returns an empty events array | pass |
| TC-MZ13 | FR-2 | returns a new object each call (not shared reference) | pass |
| TC-06LJ | FR-2 | returned object satisfies CompactionRecord type shape | pass |
| TC-FB7K | FR-2 | accepts all valid condition values | pass |
| TC-ZWJ0 | FR-3 | default Claude Code argv loads no kb/MCP (--strict-mcp-config) | pass |
| TC-T7QS | FR-3 | describeAgentCommand prefers an explicit agent-cmd override | pass |
| TC-2MB7 | FR-3 | defaultCursorArgv uses read-only ask mode with json output | pass |
| TC-V3J6 | FR-3 | accepts claude and cursor | pass |
| TC-SDYJ | FR-3 | throws on unknown backends | pass |
| TC-W3MT | FR-3 | resolves the agent binary (claude by default, cursor → agent, else agent-cmd) | pass |
| TC-0X1A | FR-3 | throws an actionable error naming the missing binary and --skip-control | pass |
| TC-6W23 | FR-3 | throws when the control prompt lacks {{question}} | pass |
| TC-VYXT | FR-3 | passes for an available binary with a valid prompt | pass |
| TC-9F95 | FR-3 | shows tokens and duration for Cursor-style telemetry | pass |
| TC-ELCS | FR-3 | shows turns and cost for Claude-style telemetry | pass |
| TC-GGJ3 | FR-3 | reads Cursor Agent CLI camelCase usage fields | pass |
| TC-NXM1 | FR-3 | parses the trailing JSON object even with a leading banner | pass |
| TC-K87Y | FR-3 | throws when there is no JSON object | pass |
| TC-83D9 | FR-3 | runs the agent per question and builds a scored control block | pass |
| TC-QCRR | FR-3 | returns partial when the agent fails on some questions | pass |
| TC-0TBQ | FR-3 | throws when the control prompt lacks the {{question}} placeholder | pass |
| TC-BSVU | FR-3 | returns complete_unscored when agent answers succeed but auto-score throws | pass |
| TC-LJI0 | FR-3 | computes kb-minus-control deltas per axis | pass |
| TC-SUT0 | FR-3 | reads a control JSON result (the __control__ sentinel) | pass |
| TC-908T | FR-3 | falls back to kb-query text parsing for non-control files | pass |
| TC-DVM8 | FR-3 | tags control vs kb artifacts | pass |
| TC-RXUO | FR-4 | returns the result immediately when the fn succeeds on the first attempt | pass |
| TC-PLJ7 | FR-4 | retries and succeeds on a later attempt | pass |
| TC-4H5X | FR-4 | throws the last error after exhausting all attempts | pass |
| TC-IUER | FR-4 | does not retry on success even with attempts > 1 | pass |
| TC-Y7AL | FR-4 | every rubric axis defines five labels mapping onto ordinal levels 0–4 | pass |
| TC-Y3SD | FR-4 | scoreFromLabel resolves a known label to its ordinal level | pass |
| TC-KXI0 | FR-4 | scoreFromLabel tolerates casing, spaces, and hyphens | pass |
| TC-4YKU | FR-4 | scoreFromLabel falls back to the legacy numeric path | pass |
| TC-4BGW | FR-4 | scoreFromLabel returns 0 for an unrecognized verdict | pass |
| TC-V9RK | FR-4 | the rubric instructs the judge to pick labels, not numbers | pass |
| TC-JT1Y | FR-4 | parses a top-level JSON array from judge output | pass |
| TC-40SW | FR-4 | scores more than SCORE_BATCH_SIZE questions in multiple judge batches | pass |
| TC-5T8E | FR-5 | returns content and length for an existing file | pass |
| TC-44KL | FR-5 | returns an error for a non-existent file | pass |
| TC-4IEQ | FR-5 | reads an empty file without error | pass |
| TC-DHDL | FR-5 | reads multiline content correctly | pass |
| TC-V043 | FR-5 | returns sorted entries for an existing directory | pass |
| TC-D7QW | FR-5 | returns an empty array for an empty directory | pass |
| TC-P1XN | FR-5 | includes subdirectory names | pass |
| TC-G7GN | FR-5 | returns an error for a non-existent path | pass |
| TC-MVWB | FR-5 | returns matching lines for a literal pattern | pass |
| TC-EG4R | FR-5 | is case-insensitive | pass |
| TC-0EFS | FR-5 | supports regex patterns | pass |
| TC-G47I | FR-5 | falls back to literal match for invalid regex | pass |
| TC-LPV6 | FR-5 | returns empty array when no lines match | pass |
| TC-ESG6 | FR-5 | returns contentLengthChars | pass |
| TC-I078 | FR-5 | returns an error for a non-existent file | pass |
| TC-HTU8 | FR-5 | dispatches read_file | pass |
| TC-9TXH | FR-5 | dispatches list_directory | pass |
| TC-VO4O | FR-5 | dispatches search_file_contents | pass |
| TC-7Z34 | FR-5 | has exactly three tool definitions | pass |
| TC-GXI1 | FR-5 | each definition has name, description, and schema | pass |
| TC-2AVO | FR-5 | includes the repo path in the prompt | pass |
| TC-1PDL | FR-5 | wraps output in filesystem-tools tags | pass |
| TC-C438 | FR-5 | includes tool names in the JSON | pass |
| TC-UD19 | FR-6 | Returns null for invalid JSON | pass |
| TC-XIZK | FR-6 | Returns null when analysis is empty | pass |
| TC-1ZNP | FR-6 | Returns null when veto_flag is missing | pass |
| TC-UZDO | FR-6 | Returns parsed verdict for valid input | pass |
| TC-U6WE | FR-6 | All judges agree with score 5 → loss = 0 | pass |
| TC-BMC9 | FR-6 | All judges score 0 → loss = 1 | pass |
| TC-PWXO | FR-6 | One judge vetoes, 2 do not → not vetoed (count < threshold) | pass |
| TC-A2HX | FR-6 | Two judges veto → L_jury = 1.0, vetoed = true | pass |
| TC-8CDR | FR-6 | Malformed JSON → counts as veto; two malformed judges → L_jury = 1.0 | pass |
| TC-OMXN | FR-6 | biasConfig omitted entirely → DEFAULT_BIAS_CONFIG applied, no runtime error | pass |
| TC-HYL5 | FR-6 | Mixed scores produce expected L_jury (no biases) | pass |
| TC-VNLU | FR-6 | raw score 5 on 1000-token candidate → adjustedScore ≈ 0.724 | pass |
| TC-BAND | FR-6 | Normalization off → adjustedScores equal raw scores | pass |
| TC-M94K | FR-6 | forward=5, reversed=1 → averaged=3, warning emitted | pass |
| TC-WHTL | FR-6 | forward=5, reversed=4 → averaged=4.5, no consistency warning | pass |
| TC-XBB9 | FR-6 | positionConsistencyDelta absent when debiasing is off | pass |
| TC-1I7Y | FR-6 | openai judge with generatorProviderName=openai → weight=0.5, warning emitted | pass |
| TC-0IZ5 | FR-6 | Down-weighted judge still contributes its veto count (Example D) | pass |
| TC-HJX0 | FR-6 | Weighted mean correctly down-weights self-enhancement judge (Example C) | pass |
| TC-PPC2 | FR-6 | Two openai judges + generator=anthropic → throws (only 1 distinct non-generator family) | pass |
| TC-24LW | FR-6 | openai + gemini judges + generator=anthropic → does not throw | pass |
| TC-1W05 | FR-6 | enforceModelFamilyDiversity=false → skips diversity check even with same-family judges | pass |
| TC-7RC4 | FR-7 | returns empty array for empty string | pass |
| TC-VB9N | FR-7 | returns empty array when no manifest block present | pass |
| TC-VE15 | FR-7 | extracts files from a fenced JSON block with manifest key | pass |
| TC-B8IT | FR-7 | handles deleted-only manifest | pass |
| TC-XCH5 | FR-7 | combines modified, created, deleted in that order | pass |
| TC-WSX8 | FR-7 | filters out blank entries | pass |
| TC-9HXH | FR-7 | trims whitespace from file paths | pass |
| TC-VIDT | FR-7 | inline fallback returns empty for nested JSON (lazy regex stops at first inner }) | pass |
| TC-AGFS | FR-7 | prefers fenced block over inline JSON when both present | pass |
| TC-MVQW | FR-7 | returns empty array when JSON is invalid | pass |
| TC-4MGT | FR-7 | returns empty array when JSON lacks manifest key | pass |
| TC-3MYE | FR-7 | handles non-array values in manifest fields gracefully | pass |
| TC-OA9F | FR-7 | passes when declared matches actual changes | pass |
| TC-ZC37 | FR-7 | fails when an actual change is not declared | pass |
| TC-YQDS | FR-7 | passes with phantom declaration (declared but not changed) | pass |
| TC-786X | FR-7 | passes with no changes and empty manifest | pass |
| TC-4OZI | FR-7 | reports declared and actual on the result | pass |
| TC-BFA1 | FR-8 | Given all zero losses, lMoel = 0 | pass |
| TC-T28H | FR-8 | Given all maximum losses, lMoel = 1 | pass |
| TC-XP7F | FR-8 | lCorrectness equals lJury | pass |
| TC-MBFW | FR-8 | Given weights that do not sum to 1, throws with sum in message | pass |
| TC-9YCP | FR-8 | Given a negative weight, throws | pass |
| TC-G5K2 | FR-8 | Given a loss component outside [0,1], throws | pass |
| TC-LC60 | FR-8 | Result serializes to JSON with no undefined values | pass |
| TC-2HKE | FR-8 | taskId and condition are set on the result | pass |
| TC-K9J0 | FR-8 | Given N > K, hypothesisConfirmed is true and N-K delta is positive | pass |
| TC-LZXK | FR-8 | Given K > N, hypothesisConfirmed is false | pass |
| TC-B380 | FR-8 | Given only K condition, hypothesisConfirmed is false | pass |
| TC-1KRD | FR-8 | Three conditions produce all pairwise entries | pass |
| TC-KDPE | FR-9 | Given a relevance arg, then quality averages three axes (back-compat without it) | pass |
| TC-052C | FR-9 | Given an off-topic-but-correct answer, then success_score is lower than a focused one | pass |
| TC-5CS1 | FR-9 | Given no relevance, then success_score matches the legacy two-axis quality | pass |
| TC-8FHT | FR-9 | Given the rubric, then it scores a Relevance axis and requires it in the schema | pass |
| TC-B63S | FR-9 | Given a retrieval detail with a curation segment, then it parses kept/dropped | pass |
| TC-L4F0 | FR-9 | Given details without curation, then parse returns null and summary is null | pass |
| TC-UJ4D | FR-9 | Given several curated details, then it aggregates retrieval precision | pass |
| TC-E2NX | FR-9 | Given the new fields, then scoreMetric reads relevance and the strict pass gate | pass |
| TC-QNVX | FR-9 | Given only the legacy pass field, then scoreMetric falls back to it | pass |
| TC-I5SX | FR-10 | Given zero tokens, returns loss = 0 and weightedTotal = 0 | pass |
| TC-IZUC | FR-10 | Given exactly at budget (fresh only), returns loss = 1.0 | pass |
| TC-A94O | FR-10 | Given tokens far above budget, loss is clamped at 1.0 | pass |
| TC-CC9F | FR-10 | Cached-heavy run has lower loss than fresh-heavy run with same raw total | pass |
| TC-ROLQ | FR-10 | Given delta = 0, cached tokens contribute nothing to weightedTotal | pass |
| TC-EQ0Z | FR-10 | Breakdown fields are summed correctly across multiple steps | pass |
| TC-OLU7 | FR-10 | Result budget field reflects the budget passed in | pass |
| TC-3AG4 | FR-11 | includes run name and suite in header | pass |
| TC-AEFX | FR-11 | renders task id in the table | pass |
| TC-K1B1 | FR-11 | shows positive N-K delta when N > K | pass |
| TC-91TX | FR-11 | shows hypothesisConfirmed: true when N > K for all tasks | pass |
| TC-VP45 | FR-11 | shows hypothesisConfirmed: false when K >= N for any task | pass |
| TC-3BG0 | FR-11 | renders aggregate row | pass |
| TC-J6UY | FR-11 | shows dash for null lMoel values | pass |
| TC-PNB7 | FR-11 | contains correct number of table separator rows | pass |
| TC-EHZH | FR-11 | returns correct runName and suite | pass |
| TC-XCFB | FR-11 | hypothesisConfirmed is true when N > K for all tasks | pass |
| TC-RJBS | FR-11 | hypothesisConfirmed is false when K > N for any task | pass |
| TC-XEMC | FR-11 | taskRows have correct lMoel values | pass |
| TC-FU9T | FR-11 | nKDelta is N minus K | pass |
| TC-AUEJ | FR-11 | nKDelta is null when either N or K is missing | pass |
| TC-8Z2B | FR-11 | per-task hypothesisConfirmed is null when either condition is missing | pass |
| TC-LES6 | FR-11 | aggregate meanLMoelByCondition is mean across tasks | pass |
| TC-JL4K | FR-11 | aggregate nKDelta is mean N minus mean K | pass |
| TC-Y7WN | FR-11 | handles empty tasks array without throwing | pass |
| TC-KMJG | FR-11 | terminated conditions show lMoel null and terminated true | pass |
| TC-FK33 | FR-12 | Given an empty trajectory, returns 0 | pass |
| TC-AZK3 | FR-12 | Given 5 unique steps within limit, returns expected combined loss | pass |
| TC-7KW4 | FR-12 | Given same tool called 5 times with identical args, returns high redundancy | pass |
| TC-WBJK | FR-12 | Given step count at ceiling, step component equals 1.0 | pass |
| TC-PSOG | FR-12 | Given step count exceeding ceiling, loss is clamped at 1.0 | pass |
| TC-IT3X | FR-12 | Same tool with different args does not count as duplicate | pass |
| TC-2OLV | FR-13 | lowercases and replaces non-alphanumeric with hyphens | pass |
| TC-JIRJ | FR-13 | trims leading and trailing hyphens | pass |
| TC-TGGZ | FR-13 | truncates to 48 chars | pass |
| TC-G03R | FR-13 | returns "repo" for empty input | pass |
| TC-F95C | FR-13 | extracts leaf from https URL | pass |
| TC-MG06 | FR-13 | extracts leaf from git@ SCP URL | pass |
| TC-7UG5 | FR-13 | strips .git suffix | pass |
| TC-D72Z | FR-13 | falls back to "repo" for invalid URL | pass |
| TC-DCYJ | FR-13 | prefixes with eval- | pass |
| TC-MUBE | FR-13 | sanitizes the suite id | pass |
| TC-QVPC | FR-13 | parses entities and relationships | pass |
| TC-D759 | FR-13 | returns 0 for missing counts | pass |
| TC-E17K | FR-13 | extracts the final answer, not the first partial one | pass |
| TC-03XB | FR-13 | extracts result count from matches line | pass |
| TC-0XES | FR-13 | extracts provenance from sources line | pass |
| TC-MG5D | FR-13 | extracts retrieval method | pass |
| TC-I6L4 | FR-13 | returns null answer when no --- separator found | pass |
| TC-R1K5 | FR-13 | extracts direct answer before --- when no stage> answer lines (one-shot synthesis) | pass |
| TC-6QID | FR-13 | strips prefix before first { | pass |
| TC-XUUM | FR-13 | passes through text that starts with { | pass |
| TC-WCOO | FR-13 | returns trimmed text when no { present | pass |
| TC-GF88 | FR-13 | returns coverage_ratio between 0 and 1 | pass |
| TC-MEHJ | FR-13 | returns full coverage when answer contains all facets | pass |
| TC-VTOL | FR-13 | handles empty question gracefully | pass |
| TC-9AIZ | FR-13 | extracts usefulness from query scores | pass |
| TC-LOSA | FR-13 | extracts correctness | pass |
| TC-ZBRV | FR-13 | extracts pass_rate | pass |
| TC-KCNX | FR-13 | extracts success_score | pass |
| TC-S9MP | FR-13 | falls back to combined when query is absent | pass |
| TC-N4S9 | FR-13 | returns null when key is absent | pass |
| TC-KCB4 | FR-13 | weights default to 0.6 quality / 0.3 tokens / 0.1 speed summing to 1 | pass |
| TC-CTRY | FR-13 | maps perfect quality, zero tokens, zero time to 1.0 | pass |
| TC-LL9W | FR-13 | blends the three components with the configured weights | pass |
| TC-3CEX | FR-13 | clamps token and speed sub-scores to 0 when over budget | pass |
| TC-OYSU | FR-13 | returns null success_score when telemetry is missing | pass |
| TC-AQ6M | FR-13 | weights cache reads at the MOEL discount when scoring control telemetry | pass |
| TC-LACV | FR-13 | treats rubric scores at τ as adequate with diminishing returns above | pass |
| TC-E09N | FR-13 | reports ahead when kb success exceeds control by >= 0.02 | pass |
| TC-MDEB | FR-13 | reports behind when kb success trails control by >= 0.02 | pass |
| TC-EN3T | FR-13 | reports on par within the 0.02 band | pass |
| TC-9PKC | FR-13 | extracts docs count | pass |
| TC-0JQV | FR-13 | extracts entities | pass |
| TC-32QV | FR-13 | computes avg_results across query_evaluation | pass |
| TC-0G4W | FR-13 | returns null when absent | pass |
| TC-4GV4 | FR-13 | matches exact run.suite field | pass |
| TC-XU17 | FR-13 | returns true for empty suite (no filter) | pass |
| TC-PZMI | FR-13 | falls back to id match when run.suite is absent | pass |
| TC-AAX7 | FR-13 | formats signed deltas | pass |
| TC-XGYS | FR-13 | returns dash for null | pass |
| TC-D3JC | FR-13 | formats large counts compactly | pass |
| TC-BYJF | FR-13 | formats seconds and minutes | pass |
| TC-75VW | FR-13 | reports behind when all axes lose | pass |
| TC-ZP0Q | FR-13 | reports ahead when all axes tie or win | pass |
| TC-H7HQ | FR-13 | returns largest negative gaps first | pass |
| TC-3CD9 | FR-13 | returns empty string for empty input | pass |
| TC-SOWJ | FR-13 | returns all mid-char for flat input | pass |
| TC-LNVR | FR-13 | returns a string of the right length for varied input | pass |
| TC-6AXZ | FR-13 | filters logs by eval base with a generous limit | pass |
| TC-JLOR | FR-13 | finds the latest init run id | pass |
| TC-8JN0 | FR-13 | finds the latest scan run id | pass |
| TC-PBQB | FR-13 | returns null when command is absent | pass |
| TC-ECV9 | FR-13 | maps kb condition to K and control to N | pass |
| TC-OI8L | FR-13 | writes LaTeX macros from scored artifacts | pass |
| TC-4IU4 | FR-14 | [REMOVED] parses valid codeburn status JSON | n/a |
| TC-EWD1 | FR-14 | [REMOVED] throws on malformed JSON | n/a |
| TC-1MNC | FR-15 | [REMOVED] computes today delta when no midnight crossing | n/a |
| TC-YUTZ | FR-15 | [REMOVED] falls back to month delta when today delta is negative (midnight crossing) | n/a |
| TC-F4BQ | FR-15 | [REMOVED] rounds cost delta to 4 decimal places | n/a |
| TC-NLHF | FR-15 | [REMOVED] builds artifact with correct structure | n/a |
| TC-Z2H8 | FR-15 | [REMOVED] sets base to null for raw agent | n/a |
| TC-S0NU | FR-15 | [REMOVED] generates correct path | n/a |
| TC-1FC6 | FR-13 | classifyStageTokens splits thinking (:llm) from synthesis (:answer-enrichment) | pass |
| TC-3SYS | FR-13 | parseRetrievalDetailTrace lifts loop counters from a retrieval detail line | pass |
| TC-SF77 | FR-13 | buildQuestionTimeline joins stages with the trace and derives retrieval_ms | pass |
| TC-7279 | FR-13 | buildQuestionTimeline falls back to the detail string when report.retrieval is absent | pass |
| TC-6LH6 | FR-13 | buildTimelineSummary aggregates shares and flags a thinking-dominant run | pass |
| TC-EQPT | FR-16 | buildMultiSuiteChildEnv keeps the shared multi-base attach URL and unpins the port | pass |
| TC-PT8R | FR-16 | buildChildArgv forwards --skip-scan | pass |
| TC-2FU6 | FR-16 | healthzUrl appends ?base= for multi-base probes | pass |
| TC-M1NO | FR-16 | buildKbRemoteEnv carries KB_BASE for X-KB-Base | pass |
| TC-5CS9 | FR-13 | reuses an existing session when docs are present | pass |
| TC-QCYC | FR-13 | force-init wipes the base and runs a full init | pass |
| TC-VQ75 | FR-13 | missing docs still triggers init without a wipe | pass |
| TC-T6WM | FR-13 | runReportToAnswerTelemetry maps RunReport fields | pass |
| TC-1Z6I | FR-13 | formatAnswerTelemetryLog matches control-style kb query lines | pass |
| TC-230S | FR-13 | readLatestKbQueryRunReport returns newest query for base | pass |
| TC-64J1 | FR-16 | buildKbRemoteEnv decomposes a url into KB_HOST/KB_PORT/KB_SSLMODE and sets KB_BASE | pass |
| TC-3JSP | FR-16 | allocateFreePort returns a positive integer | pass |
| TC-IF8Y | FR-16 | DEFAULT_KB_SERVER_PORT is 38117 | pass |
| TC-J8US | FR-16 | buildKbRemoteEnv passes through host and default port | pass |
| TC-NSSA | FR-16 | buildEvalOfflineEnv clears remote connection vars | pass |
| TC-VWVQ | FR-16 | allocateFreePort yields distinct ports for concurrent callers | pass |
| TC-NNML | FR-17 | buildChildArgv forwards --from-snapshot to every multi-suite child | pass |
| TC-YMWJ | FR-13 | wipeEvalBaseSession removes ~/.kb/sessions/<base> under KB_HOME | pass |
| TC-6XLE | FR-13 | wipeEvalBaseSession is a no-op when the session dir is missing | pass |
| TC-LNYU | FR-16 | SHARED_EVAL_BATCH_BASE is the placeholder `_eval-batch` | pass |
| TC-TPFS | FR-16 | buildEvalServerChildEnv scrubs operator git/base bootstrap env | pass |
| TC-QLHE | FR-18 | lists the kestra-18144 example task | pass |
| TC-TRLS | FR-18 | loadTaskYaml reads the required fields from a real task file | pass |
| TC-NRYD | FR-18 | loadTaskYaml throws a clear error for an unknown task id | pass |
| TC-4741 | FR-18 | loadTaskYaml accepts a direct path to a YAML file | pass |
| TC-U8Q7 | FR-18 | loadTaskYaml requires one of issue or prompt | pass |
| TC-96FZ | FR-18 | buildTaskPrompt returns the literal prompt field trimmed, without touching gh, when prompt is set | pass |
| TC-9LCM | FR-18 | kb arm argv is headless JSON output with the base forced into --mcp-config headers | pass |
| TC-DJEI | FR-18 | kb arm argv includes an Authorization header only when an apiKey is given | pass |
| TC-056K | FR-18 | kb arm argv inlines the kb:dev-workflow skill body into --append-system-prompt | pass |
| TC-YO7S | FR-18 | control arm argv blocks kb's MCP tools, Skill, and kb Bash commands | pass |
| TC-HUW0 | FR-18 | control arm argv strips MCP entirely via --strict-mcp-config + empty mcpServers | pass |
| TC-7BX5 | FR-18 | both arms omit --max-turns when maxTurns is falsy | pass |
| TC-HBQX | FR-18 | DEFAULT_MAX_TURNS matches control-core.mjs's control default (30) | pass |
| TC-V12N | FR-18 | cloneAtCommit clones a local repo and checks out the given commit, returning that sha | pass |
| TC-T4KK | FR-18 | cloneAtCommit with no commit given resolves to the cloned default-branch tip | pass |
| TC-TP73 | FR-18 | inspectArmOutcome reports committed:false and the uncommitted diff when nothing was committed | pass |
| TC-9K3G | FR-18 | inspectArmOutcome reports committed:true and a committed diff stat after a real commit | pass |
| TC-LM0L | FR-18 | buildArtifact schema_version and evaluation_plan point at TASK_EVALUATION.md | pass |
| TC-Y7OR | FR-18 | buildArtifact status is partial when only one arm ran, complete when at least one did | pass |
| TC-NXXF | FR-18 | buildArtifact comparison is null unless both arms ran, computed correctly when both did | pass |
| TC-24AP | FR-18 | buildArtifact task block carries the resolved prompt, not just the task id | pass |

### Related docs

- [EVAL.md](EVAL.md)
- [SERVER.md](../packages/kb-server/src/SERVER.md) (multi-base registry)
- [CONNECTION.md](../packages/kb-client/src/api/CONNECTION.md) (`X-KB-Base`)

