---
type: Spec
title: "Spec: KB Core"
sources: ./,../../tests/core
description: Behavioral specification for KB Core
tags: [spec, kb]
timestamp: 2026-06-28T04:05:29Z
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
|------|------------|
| FR-1 | Behaviors in agent-loop.test.ts |
| FR-2 | Behaviors in agent-registry.test.ts |
| FR-3 | Behaviors in db-migrations-doctype.test.ts |
| FR-4 | Behaviors in doc-fact-writer.test.ts |
| FR-5 | Behaviors in doc-generate-orchestrator.test.ts |
| FR-6 | Behaviors in doc-generate-session.test.ts |
| FR-7 | Behaviors in doc-generate-title.test.ts |
| FR-8 | Behaviors in doc-questionnaire.test.ts |
| FR-9 | Behaviors in doc-references-footer.test.ts |
| FR-10 | Behaviors in doc-supporting-facts.test.ts |
| FR-11 | Behaviors in doc-taxonomy.test.ts |
| FR-12 | Behaviors in evidence-summary.test.ts |
| FR-13 | Behaviors in fact-taxonomy.test.ts |
| FR-14 | Behaviors in fact-uri.test.ts |
| FR-15 | Behaviors in git-diff-preview.test.ts |
| FR-16 | Behaviors in init-synthesis-json.test.ts |
| FR-17 | Behaviors in integration-ingest.test.ts |
| FR-18 | Behaviors in llm-provider.test.ts |
| FR-19 | Behaviors in notion-sync.test.ts |
| FR-20 | Behaviors in okf.test.ts |
| FR-21 | Behaviors in publish-docs.test.ts |
| FR-22 | Behaviors in retrieval-context.test.ts |
| FR-23 | Behaviors in scan-fact-ingest.test.ts |
| FR-24 | Behaviors in sentence-split.test.ts |
| FR-25 | Behaviors in stream-manager.test.ts |
| FR-26 | Behaviors in string-utils.test.ts |
| FR-27 | Behaviors in telemetry.test.ts |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | Given a provider response with no tool calls, then should emit text metadata and done in order | pass |
| TC-2 | FR-1 | Given two slow tools in one turn and parallelToolCalls true, then overlap execution | pass |
| TC-3 | FR-1 | Given a provider response with tool calls and maxTurns one, then should emit tool events and max-turn termination | pass |
| TC-4 | FR-1 | Given runAgent wrapping agentLoop, then should return all streamed events as an array | pass |
| TC-5 | FR-1 | Given a collector, then records a stage per LLM turn with correct token counts | pass |
| TC-6 | FR-2 | Given seeded profiles, then listAgentProfiles includes default and research | pass |
| TC-7 | FR-2 | Given unknown profile id, then resolveAgentProfile falls back to default | pass |
| TC-8 | FR-2 | Given research id, then resolveAgentProfile returns research profile | pass |
| TC-9 | FR-2 | Given getAgentProfile, then returns undefined for unknown id | pass |
| TC-10 | FR-3 | Given documents/derived_docs/original_docs rows with architecture or checklist, then remaps to reference and runbook | pass |
| TC-11 | FR-3 | Given a fresh database with no legacy rows, then migration is a no-op and stamp is applied | pass |
| TC-12 | FR-4 | appends # for segment refs | pass |
| TC-13 | FR-4 | removes import_doc segment facts for a file and ignores other source kinds | pass |
| TC-14 | FR-4 | returns zero when the file has no segment facts | pass |
| TC-15 | FR-4 | purges facts for paths dropped from the manifest | pass |
| TC-16 | FR-4 | returns zero when manifest is empty or nothing was removed | pass |
| TC-17 | FR-5 | Given ready session, produceInitialDraft then reject then accept writes once | pass |
| TC-18 | FR-5 | second revise user prompt lists prior reviewer feedback before latest instruction | pass |
| TC-19 | FR-5 | Given user-defined sections, startGenerationSession is ready immediately and skips questionnaire | pass |
| TC-20 | FR-5 | Given user-defined sections, produceInitialDraft sends sections block not structured answers | pass |
| TC-21 | FR-5 | Given no facts in KB, produceInitialDraft throws before calling draft LLM | pass |
| TC-22 | FR-6 | Given new session, then first pending index is 0 and not all resolved | pass |
| TC-23 | FR-6 | Given answers applied until last, then status becomes ready | pass |
| TC-24 | FR-6 | Given skip on pending slot, then advances and can reach ready | pass |
| TC-25 | FR-6 | Given setSessionDraft twice, then revisions log holds unified diff | pass |
| TC-26 | FR-6 | Given sections provided, then status is ready immediately with no gathering phase | pass |
| TC-27 | FR-6 | Given sections provided, then sections are persisted and reloaded correctly | pass |
| TC-28 | FR-6 | Given no sections, then status starts as gathering with non-empty questions | pass |
| TC-29 | FR-6 | Given acceptSessionDraft, then status finalized and draft preserved | pass |
| TC-30 | FR-7 | strips trailing sentence punctuation | pass |
| TC-31 | FR-7 | truncates long run-on sentences by word and char caps | pass |
| TC-32 | FR-7 | uses first line only | pass |
| TC-33 | FR-7 | prefers documentTitle over oneLineThesis | pass |
| TC-34 | FR-7 | falls back to squeezed thesis when documentTitle missing | pass |
| TC-35 | FR-8 | Given valid type, then returns DocType | pass |
| TC-36 | FR-8 | Given invalid type, then throws | pass |
| TC-37 | FR-9 | Given facts, then renders a References section with fact:// URIs | pass |
| TC-38 | FR-9 | Given empty facts array, then returns empty string (no orphan heading) | pass |
| TC-39 | FR-9 | Given a fact id that is not prefixed, then formatFactUri returns the id unchanged | pass |
| TC-40 | FR-9 | Given a body and facts, then appends footer with blank line separation | pass |
| TC-41 | FR-9 | Given body without trailing newline and facts, then still separates cleanly | pass |
| TC-42 | FR-9 | Given no facts, then returns body with trailing newline ensured | pass |
| TC-43 | FR-10 | Given a query, then forwards to indexer.searchFacts and projects id/factText | pass |
| TC-44 | FR-10 | Given an empty query, then returns no results without calling the indexer | pass |
| TC-45 | FR-10 | Given no rows, then returns empty array | pass |
| TC-46 | FR-10 | Given no explicit limit, then defaults to 20 | pass |
| TC-47 | FR-10 | Given facts, then formats numbered id lines | pass |
| TC-48 | FR-10 | Given empty facts, then returns refusal hint block | pass |
| TC-49 | FR-11 | Given the canonical list, then contains exactly five members | pass |
| TC-50 | FR-11 | Given a known DocType, then isDocType returns true | pass |
| TC-51 | FR-11 | Given a legacy or unknown value, then isDocType returns false | pass |
| TC-52 | FR-11 | Given the legacy keys, then maps each to a current DocType | pass |
| TC-53 | FR-11 | Given a current DocType, then returns it unchanged | pass |
| TC-54 | FR-11 | Given a legacy DocType, then returns the remapped value | pass |
| TC-55 | FR-11 | Given an unknown or non-string value, then returns undefined | pass |
| TC-56 | FR-12 | Given mixed doc and code facts, then header summarizes count, mix, themes, and leads | pass |
| TC-57 | FR-12 | Given empty results, then header is omitted | pass |
| TC-58 | FR-12 | Given homogenous source kind, then mix uses all-doc shorthand | pass |
| TC-59 | FR-12 | Given duplicate lead titles, then leads are deduped | pass |
| TC-60 | FR-13 | classifies build-heavy fact text into build lane | pass |
| TC-61 | FR-13 | returns general lane when no keywords match | pass |
| TC-62 | FR-13 | infers query lane weights from lane keywords | pass |
| TC-63 | FR-14 | strips fact- prefix before scheme so sources line does not repeat fact | pass |
| TC-64 | FR-14 | passes through ids that are not fact-prefixed | pass |
| TC-65 | FR-15 | produces a valid unified diff with --- and +++ headers | pass |
| TC-66 | FR-15 | headers do NOT contain full document content | pass |
| TC-67 | FR-15 | the diff body (not header) shows the actual changed line | pass |
| TC-68 | FR-15 | does not duplicate full document content before the hunks | pass |
| TC-69 | FR-15 | context defaults to 3 lines | pass |
| TC-70 | FR-15 | returns patch unchanged when color=false | pass |
| TC-71 | FR-15 | when color=true processes all lines without throwing | pass |
| TC-72 | FR-16 | Given fenced JSON whose body contains triple backticks in a string, then does not truncate early | pass |
| TC-73 | FR-16 | Given prose then fenced JSON, then returns inner JSON only when full closing fence exists | pass |
| TC-74 | FR-16 | Given balanced JSON object, then returns doc fields | pass |
| TC-75 | FR-16 | Given INIT_SYNTHESIS_OPENAI_JSON_SCHEMA shape, then schema is strict-ready | pass |
| TC-76 | FR-17 | emits package_name_of, depends_on, and is_repo facts from package.json | pass |
| TC-77 | FR-17 | extracts service hosts from .env URL values | pass |
| TC-78 | FR-17 | re-ingest clears stale integration facts (removed dependency disappears) | pass |
| TC-79 | FR-18 | Given each provider name in factory config, then should return a provider with matching name | pass |
| TC-80 | FR-18 | Given an anthropic non-ok response, then should throw a readable api error instead of crashing on undefined content | pass |
| TC-81 | FR-18 | Given an openai malformed but successful payload, then should return safe defaults rather than throw | pass |
| TC-82 | FR-18 | Given GEMINI_API_BASE_URL, then provider calls the override host | pass |
| TC-83 | FR-18 | Given a custom Gemini model, then provider calls the matching model endpoint | pass |
| TC-84 | FR-18 | Given a Gemini system prompt and assistant history, then provider sends system_instruction and model-role contents | pass |
| TC-85 | FR-18 | Given thinkingBudget 0 on a Gemini 2.5 model, then generationConfig includes thinkingConfig | pass |
| TC-86 | FR-18 | Given Gemini parts with thought true, then visible text excludes reasoning parts | pass |
| TC-87 | FR-18 | Given Gemini preview uses the first small token budget on thoughts only, then provider retries once with a larger budget and returns visible text | pass |
| TC-88 | FR-18 | Given an Anthropic onReasoning callback, then thinking enabled, deltas streamed, and text/usage reconstructed | pass |
| TC-89 | FR-18 | Given an Anthropic streamed tool_use, then input JSON deltas reconstruct the tool call | pass |
| TC-90 | FR-18 | Given an Anthropic stream that errors, then call falls back to the non-streaming path | pass |
| TC-91 | FR-18 | Given an OpenAI reasoning stream, then reasoning deltas and tool calls reconstruct | pass |
| TC-92 | FR-18 | Given a Gemini onReasoning callback, then thought parts stream and visible text/tools reconstruct | pass |
| TC-93 | FR-19 | Given existing state with stale pages, then reports removed titles | pass |
| TC-94 | FR-19 | Given a doc with no title, then skips it with reason | pass |
| TC-95 | FR-19 | Given existing section pages, then archives stale children and recreates current docs | pass |
| TC-96 | FR-19 | Given no state file, then creates container and section pages once | pass |
| TC-97 | FR-20 | detects an OKF doc and parses recommended fields | pass |
| TC-98 | FR-20 | treats frontmatter without a type as non-OKF but still strips it | pass |
| TC-99 | FR-20 | returns plain markdown unchanged | pass |
| TC-100 | FR-20 | does not mistake a leading thematic break / prose for frontmatter | pass |
| TC-101 | FR-20 | accepts a comma-separated tags string | pass |
| TC-102 | FR-20 | degrades gracefully on malformed YAML | pass |
| TC-103 | FR-20 | is true only for frontmatter carrying a non-empty type | pass |
| TC-104 | FR-21 | splits originals vs autogenerated by is_original | pass |
| TC-105 | FR-22 | Given long fact text with no limit, then full content is kept | pass |
| TC-106 | FR-22 | Given maxContentChars set, then long fact content is truncated with ellipsis | pass |
| TC-107 | FR-22 | Given maxContentChars set, then short fact content is kept unchanged | pass |
| TC-108 | FR-22 | Given multiple ranked facts, then all bodies are included for LLM context | pass |
| TC-109 | FR-22 | Given facts, then evidence is not framed as enumerated/citable items (no "Fact N", no id= leak) | pass |
| TC-110 | FR-22 | Given tool query results, then tool payload truncates long fact bodies by default | pass |
| TC-111 | FR-23 | Given markdown with long sentences, then upserts facts with import_doc refs | pass |
| TC-112 | FR-23 | Given short heading and short prose, then ingests only segments that survive markdown splitting | pass |
| TC-113 | FR-23 | Given multiple markdown files, then emits monotonic per-file progress with current file names | pass |
| TC-114 | FR-23 | Given a re-ingest with fewer segments, then tombstones orphaned segment facts | pass |
| TC-115 | FR-23 | Given an emptied markdown file, then purges all prior segment facts | pass |
| TC-116 | FR-23 | anchors a segment to the in-resource symbol, never a global one | pass |
| TC-117 | FR-23 | anchors a segment to a global exported symbol when no resource is set | pass |
| TC-118 | FR-24 | treats ATX heading line as one segment (title only) | pass |
| TC-119 | FR-24 | preserves fenced code blocks as collapsed segments before prose | pass |
| TC-120 | FR-24 | splits multiple sentences on one line | pass |
| TC-121 | FR-24 | drops segments shorter than 8 chars after normalize | pass |
| TC-122 | FR-24 | can merge short adjacent prose into coarser scan chunks | pass |
| TC-123 | FR-24 | strips the OKF frontmatter block and segments only the body (no boosting facts) | pass |
| TC-124 | FR-24 | leaves plain markdown (no frontmatter) segmentation unchanged | pass |
| TC-125 | FR-24 | returns trimmed single sentence | pass |
| TC-126 | FR-24 | throws when multiple sentences detected | pass |
| TC-127 | FR-24 | throws on empty | pass |
| TC-128 | FR-24 | when no segment passes length filter but text is long enough, returns full trimmed text | pass |
| TC-129 | FR-24 | throws when text too short for fallback path | pass |
| TC-130 | FR-25 | Given push then snapshot, then returns copy without clearing | pass |
| TC-131 | FR-25 | Given drain, then removes buffer for channel | pass |
| TC-132 | FR-26 | lowercases and title-cases a normal word | pass |
| TC-133 | FR-26 | title-cases multiple words | pass |
| TC-134 | FR-26 | converts ALL_CAPS to Title Case | pass |
| TC-135 | FR-26 | converts SCREAMING_SNAKE_CASE to Title Case | pass |
| TC-136 | FR-26 | converts kebab-case to Title Case | pass |
| TC-137 | FR-26 | strips file extension before casing | pass |
| TC-138 | FR-26 | trims leading and trailing whitespace | pass |
| TC-139 | FR-26 | handles mixed separators | pass |
| TC-140 | FR-26 | returns the filename for a simple path | pass |
| TC-141 | FR-26 | strips directory components from a nested path | pass |
| TC-142 | FR-26 | preserves original casing — does NOT title-case | pass |
| TC-143 | FR-26 | handles Windows-style backslash separators | pass |
| TC-144 | FR-26 | returns the input unchanged when there is no path separator | pass |
| TC-145 | FR-26 | converts a path-style title to Cap Every Word | pass |
| TC-146 | FR-26 | converts a simple filename to Title Case | pass |
| TC-147 | FR-26 | converts kebab-cased filename to Title Case | pass |
| TC-148 | FR-26 | strips extension before casing | pass |
| TC-149 | FR-27 | Given gemini-2.0-flash with known tokens, then returns a positive cost | pass |
| TC-150 | FR-27 | Given gemini-2.5-pro, then applies higher pricing than gemini-2.0-flash | pass |
| TC-151 | FR-27 | Given anthropic claude-sonnet-4-6, then returns a positive cost | pass |
| TC-152 | FR-27 | Given openai gpt-4o, then returns a positive cost | pass |
| TC-153 | FR-27 | Given a model not in the pricing table, then returns 0 | pass |
| TC-154 | FR-27 | Given ollama provider, then returns 0 (local/free) | pass |
| TC-155 | FR-27 | Given unknown provider, then returns 0 | pass |
| TC-156 | FR-27 | Given zero tokens, then returns 0 | pass |
| TC-157 | FR-27 | Given a finished collector with no stages, then report totals are all zero | pass |
| TC-158 | FR-27 | Given added stages, then totals accumulate correctly | pass |
| TC-159 | FR-27 | Given an error finish, then report status and message are set | pass |
| TC-160 | FR-27 | Given startStage, then calling the returned function records the stage | pass |
| TC-161 | FR-27 | Given addStage, then does not write to stderr | pass |
| TC-162 | FR-27 | Given a report, then runId follows expected format | pass |
| TC-163 | FR-27 | Given a report, then startedAt and finishedAt are valid ISO strings | pass |
| TC-164 | FR-27 | Given a single call, then peek returns the token counts | pass |
| TC-165 | FR-27 | Given multiple calls, then peek accumulates across all calls | pass |
| TC-166 | FR-27 | Given getAndReset, then returns accumulated totals and resets to zero | pass |
| TC-167 | FR-27 | Given getAndReset called twice, then second call returns zeros | pass |
| TC-168 | FR-27 | Given two cycles using getAndReset between them, then each cycle is counted independently | pass |
| TC-169 | FR-27 | Given delegated call, then response is passed through unmodified | pass |
| TC-170 | FR-27 | Given name/model/supportsStreaming, then delegates to inner provider | pass |
| TC-171 | FR-27 | Given a report, then appends NDJSON to the correct dated file | pass |
| TC-172 | FR-27 | Given two appends, then both reports appear as separate NDJSON lines | pass |
| TC-173 | FR-27 | Given a bad logs dir path, then append does not throw and warns on stderr | pass |
| TC-174 | FR-27 | Given a fresh collector, compileTrajectory returns empty steps and non-negative elapsedMs | pass |
| TC-175 | FR-27 | Given a single step, stepIndex is 0 and fields match what was passed | pass |
| TC-176 | FR-27 | Given duplicate tool calls, both appear with sequential stepIndex values | pass |
| TC-177 | FR-27 | Given no tokens argument, all token fields default to 0 | pass |
| TC-178 | FR-27 | Given compiled trajectory, JSON round-trip produces identical result | pass |
| TC-179 | FR-27 | Given writeTrajectory, file is written at expected path and parses back correctly | pass |
| TC-513 | FR-27 | Given setRetrievalTrace, the finished report carries the trace; else it is absent | pass |
| TC-514 | FR-27 | Given a facts-loop detail string, summarizeQueryRetrievalTrace lifts passes/hops/ponds/stop/facts | pass |
| TC-515 | FR-27 | Given a curated detail + raw curation record, it lifts counts and dropped fact ids | pass |
| TC-516 | FR-27 | Given a traceDetail string, it splits per-pass hop lines in order | pass |
| TC-517 | FR-27 | Given an unknown shape, it degrades to empty fields without throwing | pass |

### Related docs

- [facts-architecture.md](facts-architecture.md)

