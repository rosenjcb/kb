---
type: Spec
title: "Spec: KB Core"
sources: [./]
# Precise, disjoint scope: tests/core minus the files owned by CHAT_REPLY.spec.md
# (chat-reply, markdown-to-slack). TC ids are per-spec, so a whole-dir claim would
# over-select CHAT_REPLY's [TC-N] tags — both specs number from TC-JLX4. Add new
# tests/core files here when they carry CORE [TC-N] tags.
tests:
  - ../../../../tests/core/agent-loop.test.ts
  - ../../../../tests/core/agent-registry.test.ts
  - ../../../../tests/core/code-fact-writer.test.ts
  - ../../../../tests/core/db-migrations-doctype.test.ts
  - ../../../../tests/core/doc-taxonomy.test.ts
  - ../../../../tests/core/entity-index-cycle.test.ts
  - ../../../../tests/core/env-boolean.test.ts
  - ../../../../tests/core/evidence-summary.test.ts
  - ../../../../tests/core/fact-taxonomy.test.ts
  - ../../../../tests/core/fact-uri.test.ts
  - ../../../../tests/core/git-diff-preview.test.ts
  - ../../../../tests/core/init-synthesis-json.test.ts
  - ../../../../tests/core/integration-ingest.test.ts
  - ../../../../tests/core/llm-error.test.ts
  - ../../../../tests/core/llm-provider.test.ts
  - ../../../../tests/core/okf.test.ts
  - ../../../../tests/core/retrieval-context.test.ts
  - ../../../../tests/core/sentence-split.test.ts
  - ../../../../tests/core/snapshot.test.ts
  - ../../../../tests/core/stream-manager.test.ts
  - ../../../../tests/core/string-utils.test.ts
  - ../../../../tests/core/telemetry.test.ts
  - ../../../../tests/core/yield.test.ts
  - ../../../../tests/core/scan-document-ingest.test.ts
  - ../../../../tests/core/markdown-sections.test.ts
description: Behavioral specification for KB Core
tags: [spec, kb]
timestamp: 2026-08-08T22:40:00Z
---

### Intro

Core library behaviors. Architecture overview: [facts-architecture.md](./facts-architecture.md).

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
| FR-1 | Behaviors in agent-loop.test.ts |
| FR-2 | Behaviors in agent-registry.test.ts |
| FR-3 | Behaviors in db-migrations-doctype.test.ts |
| FR-10 | Behaviors in doc-taxonomy.test.ts |
| FR-11 | Behaviors in evidence-summary.test.ts |
| FR-12 | Behaviors in fact-taxonomy.test.ts |
| FR-13 | Behaviors in fact-uri.test.ts |
| FR-14 | Behaviors in git-diff-preview.test.ts |
| FR-15 | Behaviors in init-synthesis-json.test.ts |
| FR-16 | Behaviors in integration-ingest.test.ts |
| FR-17 | Behaviors in llm-provider.test.ts |
| FR-19 | Behaviors in okf.test.ts |
| FR-21 | Behaviors in retrieval-context.test.ts |
| FR-22 | Whole-markdown document ingest (`scan-document-ingest.test.ts`) |
| FR-23 | Behaviors in sentence-split.test.ts |
| FR-24 | Behaviors in stream-manager.test.ts |
| FR-25 | Behaviors in string-utils.test.ts |
| FR-26 | Behaviors in telemetry.test.ts |
| FR-27 | Behaviors in code-fact-writer.test.ts |
| FR-28 | [NEW] Classify LLM transport failures into a structured error (provider, HTTP status, kind, retryability) so callers can distinguish a spent credit balance, a rate limit, bad credentials, and a timeout from one another — and from a model that simply returned nothing |
| FR-29 | [NEW] Cap Gemini thinking: every Gemini 2.5/3 generateContent call sends an explicit `thinkingConfig.thinkingBudget` (never omit it). Resolve budget as per-call `thinkingBudget` → `GEMINI_THINKING_BUDGET` env → mode default (1024 when reasoning/`includeThoughts`, else 0). Parse `usageMetadata` so `outputTokens` = `candidatesTokenCount` + `thoughtsTokenCount` (thinking billed as output) |
| FR-30 | [NEW] Split a markdown body into indexable sections on heading boundaries, carrying the heading trail, merging runs too small to stand alone and splitting oversized ones on paragraph boundaries — so the retrieval unit is a section rather than a whole file |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-JLX4 | FR-1 | Given a provider response with no tool calls, then should emit text metadata and done in order | pass |
| TC-QQXJ | FR-1 | Given two slow tools in one turn and parallelToolCalls true, then overlap execution | pass |
| TC-DVEO | FR-1 | Given a provider response with tool calls and maxTurns one, then should emit tool events and max-turn termination | pass |
| TC-20G2 | FR-1 | Given runAgent wrapping agentLoop, then should return all streamed events as an array | pass |
| TC-7VQ2 | FR-1 | Given a collector, then records a stage per LLM turn with correct token counts | pass |
| TC-3GRG | FR-2 | Given seeded profiles, then listAgentProfiles includes default and research | pass |
| TC-7MLT | FR-2 | Given unknown profile id, then resolveAgentProfile falls back to default | pass |
| TC-FCFY | FR-2 | Given research id, then resolveAgentProfile returns research profile | pass |
| TC-ATRV | FR-2 | Given getAgentProfile, then returns undefined for unknown id | pass |
| TC-MC1Y | FR-3 | Given documents/derived_docs/original_docs rows with architecture or checklist, then remaps to reference and runbook | pass |
| TC-NZOZ | FR-3 | Given a fresh database with no legacy rows, then migration is a no-op and stamp is applied | pass |
| TC-7480 | FR-10 | Given the canonical list, then contains exactly five members | pass |
| TC-L48H | FR-10 | Given a known DocType, then isDocType returns true | pass |
| TC-RHU4 | FR-10 | Given a legacy or unknown value, then isDocType returns false | pass |
| TC-LPJ2 | FR-10 | Given the legacy keys, then maps each to a current DocType | pass |
| TC-V9J1 | FR-10 | Given a current DocType, then returns it unchanged | pass |
| TC-U4FC | FR-10 | Given a legacy DocType, then returns the remapped value | pass |
| TC-X0PJ | FR-10 | Given an unknown or non-string value, then returns undefined | pass |
| TC-WX2Q | FR-11 | Given mixed doc and code facts, then header summarizes count, mix, themes, and leads | pass |
| TC-9UBM | FR-11 | Given empty results, then header is omitted | pass |
| TC-WS0E | FR-11 | Given homogenous source kind, then mix uses all-doc shorthand | pass |
| TC-RF7O | FR-11 | Given duplicate lead titles, then leads are deduped | pass |
| TC-7ICI | FR-12 | classifies build-heavy fact text into build lane | pass |
| TC-8B9L | FR-12 | returns general lane when no keywords match | pass |
| TC-9KC4 | FR-12 | infers query lane weights from lane keywords | pass |
| TC-U5SU | FR-13 | strips fact- prefix before scheme so sources line does not repeat fact | pass |
| TC-BBJ0 | FR-13 | passes through ids that are not fact-prefixed | pass |
| TC-5OC8 | FR-14 | produces a valid unified diff with --- and +++ headers | pass |
| TC-LXRC | FR-14 | headers do NOT contain full document content | pass |
| TC-CYIQ | FR-14 | the diff body (not header) shows the actual changed line | pass |
| TC-LCG9 | FR-14 | does not duplicate full document content before the hunks | pass |
| TC-I9SO | FR-14 | context defaults to 3 lines | pass |
| TC-YQCF | FR-14 | returns patch unchanged when color=false | pass |
| TC-O4MN | FR-14 | when color=true processes all lines without throwing | pass |
| TC-IE43 | FR-15 | Given fenced JSON whose body contains triple backticks in a string, then does not truncate early | pass |
| TC-VVF7 | FR-15 | Given prose then fenced JSON, then returns inner JSON only when full closing fence exists | pass |
| TC-4UFR | FR-15 | Given balanced JSON object, then returns doc fields | pass |
| TC-RSRD | FR-15 | Given INIT_SYNTHESIS_OPENAI_JSON_SCHEMA shape, then schema is strict-ready | pass |
| TC-0V5Q | FR-16 | emits package_name_of, depends_on, and is_repo facts from package.json | pass |
| TC-ZC86 | FR-16 | extracts service hosts from .env URL values | pass |
| TC-8VVX | FR-16 | re-ingest clears stale integration facts (removed dependency disappears) | pass |
| TC-SXZ1 | FR-17 | Given each provider name in factory config, then should return a provider with matching name | pass |
| TC-N9BG | FR-17 | Given GeminiProvider with no model arg, then defaults to documented gemini-3-flash-preview | pass |
| TC-3E7P | FR-17 | Given an anthropic non-ok response, then should throw a readable api error instead of crashing on undefined content | pass |
| TC-XULV | FR-17 | Given an openai malformed but successful payload, then should return safe defaults rather than throw | pass |
| TC-O74N | FR-17 | Given GEMINI_API_BASE_URL, then provider calls the override host | pass |
| TC-3MRN | FR-17 | Given a custom Gemini model, then provider calls the matching model endpoint | pass |
| TC-RPTI | FR-17 | Given a Gemini system prompt and assistant history, then provider sends system_instruction and model-role contents | pass |
| TC-HE3D | FR-17 | Given thinkingBudget 0 on a Gemini 2.5 model, then generationConfig includes thinkingConfig | pass |
| TC-CSZM | FR-17 | Given Gemini parts with thought true, then visible text excludes reasoning parts | pass |
| TC-ORNK | FR-17 | Given Gemini preview uses the first small token budget on thoughts only, then provider retries once with a larger budget and returns visible text | pass |
| TC-M624 | FR-17 | Given an Anthropic onReasoning callback, then thinking enabled, deltas streamed, and text/usage reconstructed | pass |
| TC-816B | FR-17 | Given an Anthropic streamed tool_use, then input JSON deltas reconstruct the tool call | pass |
| TC-OLC9 | FR-17 | Given an Anthropic stream that errors, then call falls back to the non-streaming path | pass |
| TC-FYH6 | FR-17 | Given an OpenAI reasoning stream, then reasoning deltas and tool calls reconstruct | pass |
| TC-WJG0 | FR-17 | Given a Gemini onReasoning callback, then thought parts stream and visible text/tools reconstruct | pass |
| TC-TPZA | FR-19 | detects an OKF doc and parses recommended fields | pass |
| TC-WXY0 | FR-19 | treats frontmatter without a type as non-OKF but still strips it | pass |
| TC-9EG0 | FR-19 | returns plain markdown unchanged | pass |
| TC-NLCO | FR-19 | does not mistake a leading thematic break / prose for frontmatter | pass |
| TC-QTA2 | FR-19 | accepts a comma-separated tags string | pass |
| TC-HE4E | FR-19 | degrades gracefully on malformed YAML | pass |
| TC-M6K4 | FR-19 | is true only for frontmatter carrying a non-empty type | pass |
| TC-CIHI | FR-21 | Given long fact text with no limit, then full content is kept | pass |
| TC-1BKJ | FR-21 | Given maxContentChars set, then long fact content is truncated with ellipsis | pass |
| TC-W9EV | FR-21 | Given maxContentChars set, then short fact content is kept unchanged | pass |
| TC-OCXT | FR-21 | Given multiple ranked facts, then all bodies are included for LLM context | pass |
| TC-FXSR | FR-21 | Given facts, then evidence is not framed as enumerated/citable items (no "Fact N", no id= leak) | pass |
| TC-DVRY | FR-21 | Given tool query results, then tool payload truncates long fact bodies by default | pass |
| TC-GBG0 | FR-23 | treats ATX heading line as one segment (title only) | pass |
| TC-91WE | FR-23 | preserves fenced code blocks as collapsed segments before prose | pass |
| TC-0TD6 | FR-23 | splits multiple sentences on one line | pass |
| TC-ETNB | FR-23 | drops segments shorter than 8 chars after normalize | pass |
| TC-Z6EV | FR-23 | can merge short adjacent prose into coarser scan chunks | pass |
| TC-3KP8 | FR-23 | strips the OKF frontmatter block and segments only the body (no boosting facts) | pass |
| TC-Q7J0 | FR-23 | leaves plain markdown (no frontmatter) segmentation unchanged | pass |
| TC-DCXE | FR-23 | returns trimmed single sentence | pass |
| TC-ZURE | FR-23 | throws when multiple sentences detected | pass |
| TC-IET1 | FR-23 | throws on empty | pass |
| TC-EF11 | FR-23 | when no segment passes length filter but text is long enough, returns full trimmed text | pass |
| TC-795W | FR-23 | throws when text too short for fallback path | pass |
| TC-PN0C | FR-24 | Given push then snapshot, then returns copy without clearing | pass |
| TC-VU32 | FR-24 | Given drain, then removes buffer for channel | pass |
| TC-AZWV | FR-25 | lowercases and title-cases a normal word | pass |
| TC-21QQ | FR-25 | title-cases multiple words | pass |
| TC-27BH | FR-25 | converts ALL_CAPS to Title Case | pass |
| TC-2VO8 | FR-25 | converts SCREAMING_SNAKE_CASE to Title Case | pass |
| TC-HGMQ | FR-25 | converts kebab-case to Title Case | pass |
| TC-LBPH | FR-25 | strips file extension before casing | pass |
| TC-RY82 | FR-25 | trims leading and trailing whitespace | pass |
| TC-C5XY | FR-25 | handles mixed separators | pass |
| TC-0DCP | FR-25 | returns the filename for a simple path | pass |
| TC-TDA7 | FR-25 | strips directory components from a nested path | pass |
| TC-RO9F | FR-25 | preserves original casing — does NOT title-case | pass |
| TC-01AZ | FR-25 | handles Windows-style backslash separators | pass |
| TC-0SAT | FR-25 | returns the input unchanged when there is no path separator | pass |
| TC-JBOZ | FR-25 | converts a path-style title to Cap Every Word | pass |
| TC-LBP9 | FR-25 | converts a simple filename to Title Case | pass |
| TC-KABW | FR-25 | converts kebab-cased filename to Title Case | pass |
| TC-68YF | FR-25 | strips extension before casing | pass |
| TC-JMSN | FR-26 | Given gemini-2.0-flash with known tokens, then returns a positive cost | pass |
| TC-XO2P | FR-26 | Given gemini-2.5-pro, then applies higher pricing than gemini-2.0-flash | pass |
| TC-AJHB | FR-26 | Given anthropic claude-sonnet-4-6, then returns a positive cost | pass |
| TC-66IV | FR-26 | Given openai gpt-4o, then returns a positive cost | pass |
| TC-Z8KP | FR-26 | Given a model not in the pricing table, then returns 0 | pass |
| TC-OOCY | FR-26 | Given ollama provider, then returns 0 (local/free) | pass |
| TC-XTIY | FR-26 | Given unknown provider, then returns 0 | pass |
| TC-E48Q | FR-26 | Given zero tokens, then returns 0 | pass |
| TC-98ZG | FR-26 | Given a finished collector with no stages, then report totals are all zero | pass |
| TC-0DL2 | FR-26 | Given added stages, then totals accumulate correctly | pass |
| TC-04TO | FR-26 | Given an error finish, then report status and message are set | pass |
| TC-CKUV | FR-26 | Given startStage, then calling the returned function records the stage | pass |
| TC-1B1C | FR-26 | Given addStage, then does not write to stderr | pass |
| TC-GY0F | FR-26 | Given a report, then runId follows expected format | pass |
| TC-DEKK | FR-26 | Given a report, then startedAt and finishedAt are valid ISO strings | pass |
| TC-9Z1L | FR-26 | Given a single call, then peek returns the token counts | pass |
| TC-JEK9 | FR-26 | Given multiple calls, then peek accumulates across all calls | pass |
| TC-JHNK | FR-26 | Given getAndReset, then returns accumulated totals and resets to zero | pass |
| TC-QHP0 | FR-26 | Given getAndReset called twice, then second call returns zeros | pass |
| TC-WIO0 | FR-26 | Given two cycles using getAndReset between them, then each cycle is counted independently | pass |
| TC-D2DA | FR-26 | Given delegated call, then response is passed through unmodified | pass |
| TC-24RD | FR-26 | Given name/model/supportsStreaming, then delegates to inner provider | pass |
| TC-SPBB | FR-26 | Given a report, then appends NDJSON to the correct dated file | pass |
| TC-ZNRF | FR-26 | Given two appends, then both reports appear as separate NDJSON lines | pass |
| TC-N8IZ | FR-26 | Given a bad logs dir path, then append does not throw and warns on stderr | pass |
| TC-W2AY | FR-26 | Given a fresh collector, compileTrajectory returns empty steps and non-negative elapsedMs | pass |
| TC-9VJ7 | FR-26 | Given a single step, stepIndex is 0 and fields match what was passed | pass |
| TC-8L9W | FR-26 | Given duplicate tool calls, both appear with sequential stepIndex values | pass |
| TC-Q4D5 | FR-26 | Given no tokens argument, all token fields default to 0 | pass |
| TC-6SM7 | FR-26 | Given compiled trajectory, JSON round-trip produces identical result | pass |
| TC-BAPH | FR-26 | Given writeTrajectory, file is written at expected path and parses back correctly | pass |
| TC-CET2 | FR-26 | Given setRetrievalTrace, the finished report carries the trace; else it is absent | pass |
| TC-DDN7 | FR-26 | Given a hybrid detail string, summarizeQueryRetrievalTrace lifts docs/symbols/facts/hops/expanded | pass |
| TC-IL9R | FR-26 | Given a curated detail + raw curation record, it lifts counts and dropped fact ids | pass |
| TC-4H6M | FR-26 | Given an unknown shape, it degrades to empty fields without throwing | pass |
| TC-1IPC | FR-27 | tombstones only the removed file, scoped to its repo, leaving siblings and other repos intact | pass |
| TC-FSDL | FR-27 | is a no-op when nothing was removed | pass |
| TC-HVMQ | FR-27 | contrast: blanket tombstoneStaleCodeFacts would purge unchanged files on a partial rescan | pass |
| TC-W9L2 | FR-28 | credit exhaustion reported as 400, 429, or 402 across providers | classified insufficient_credits regardless of status |
| TC-5R2T | FR-28 | 429 / 401 / 403 / 5xx statuses | mapped to rate_limit, auth, server with correct retryability and operator-action flags |
| TC-DI64 | FR-28 | legacy "[provider] API request failed (NNN)" string error | provider, status, and kind recovered by re-parsing |
| TC-22WZ | FR-28 | AbortError and fetch TypeError | classified timeout and network |
| TC-8GII | FR-28 | an already-structured error | returned unchanged, not re-wrapped |
| TC-CNLV | FR-28 | a thrown provider error converted to a failure record | stage, kind, provider preserved; description names the operator action |
| TC-FA82 | FR-29 | resolveGeminiThinkingBudget with call arg / GEMINI_THINKING_BUDGET / unset | prefers call arg, then env, then mode default (1024 when includeThoughts, else 0) |
| TC-B1XK | FR-29 | plain Gemini call with no thinkingBudget and unset GEMINI_THINKING_BUDGET | generationConfig.thinkingConfig.thinkingBudget is 0 (config never omitted) |
| TC-N1Y9 | FR-29 | Gemini usageMetadata with candidatesTokenCount + thoughtsTokenCount (generateContent) | usage.outputTokens equals sum (thinking folded into output) |
| TC-5WW6 | FR-29 | Gemini stream usageMetadata with thoughtsTokenCount (and totalTokenCount fallback) | stream usage.outputTokens includes thinking; total−prompt used when thoughts field absent |
| TC-BYOL | FR-22 | indexes whole markdown files, links them to symbols, and retrieves via hybrid FTS | pass |
| TC-ELHG | FR-22 | re-scan skips unchanged documents by content hash and re-indexes changed ones | pass |
| TC-MDS1 | FR-30 | Empty or whitespace-only body | No sections returned |
| TC-MDS2 | FR-30 | Document with no headings | Indexes as one section rather than disappearing |
| TC-MDS3 | FR-30 | Sibling headings | Each becomes its own section with its own heading |
| TC-MDS4 | FR-30 | Nested heading | Heading trail carries ancestors ("Parent > Child") |
| TC-MDS5 | FR-30 | `#` line inside a fenced code block | Not treated as a heading |
| TC-MDS6 | FR-30 | Section below the minimum size | Merged forward instead of fragmenting |
| TC-MDS7 | FR-30 | Section far over the size ceiling | Split on paragraph boundaries, parent heading retained |
| TC-MDS8 | FR-30 | Content before the first heading | Preamble kept with an empty heading |

### Related docs

- [facts-architecture.md](facts-architecture.md)

