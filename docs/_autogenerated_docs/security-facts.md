---
layout: default
title: Security Facts
date: '2026-04-20'
kb_id: security-facts
tags:
  - security
  - fact
categories:
  - reference
---

- The agentLoop event types are: text (LLM prose response), tool_start (before tool execution, includes toolName and toolUseId), tool_result (after tool execution, includes result and isError flag), metadata (token usage per turn: inputTokens and outputTokens), and done (loop exit with reason: no_tool_calls or max_turns_reached). (source: consumer)

- agentLoop configuration: AgentLoopConfig accepts maxTurns (default 10, hard ceiling on loop iterations), maxTokens (passed to LLM), and temperature (passed to LLM). The runAgent() helper collects all events into an array for testing and simple scenarios. Message history is built up across turns: each turn appends the assistant response and tool results before the next LLM call. (source: consumer)

- pass-consolidate in kb init uses a single LLM call at temperature 0.1 with a capped output budget under the 4096-token model limit. It reviews enriched docs, merges groups with more than about 40% overlap, preserves unique facts, and reports the merged count in progress output. (source: consumer)

- KB run telemetry: RunCollector/ReportWriter in src/core/telemetry.ts writes per-stage timing and token usage to ~/.kb/logs/<date>.jsonl (NDJSON). Each kb command (query, submit, validate, dispute, explain, init) creates a RunCollector, passes it to runIntentLoop or runKbInit, and appends a RunReport on exit. Gemini pricing is exact; Anthropic/OpenAI are stubbed at 0. --debug flag (per-subcommand) prints live stage lines to stderr without affecting stdout. (source: consumer)

- KB telemetry e2e test: token counting is working correctly across init cycles and query answer-enrichment (source: consumer)

- e2e telemetry validation: all four commands now track timing and tokens correctly (source: consumer)

- KB run telemetry: RunCollector/ReportWriter in src/core/telemetry.ts writes per-stage timing and token usage to ~/.kb/logs/<date>.jsonl (NDJSON). Each kb command (query, submit, validate, dispute, explain, init, invalidate) creates a RunCollector and appends a RunReport on exit. --debug flag (per-subcommand) prints live stage lines to stderr without affecting stdout. Gemini pricing is exact (gemini-2.0-flash: $0.075/1M in, $0.30/1M out); Anthropic/OpenAI stubbed at 0. (source: consumer)

- Token counting: TokenCountingProvider in src/core/telemetry.ts wraps any LLMProvider and accumulates inputTokens/outputTokens across all .call() invocations. init-cli uses it per-cycle (getAndReset() between cycles). index.ts wraps the provider for intent commands and captures tokens from the graph-extraction LLM call (submit) and answer-enrichment LLM call (query). Intent retrieval stages (SQLite-only) correctly show 0 tokens. (source: consumer)

- kb logs subcommand: src/cli/logs-cli.ts implements 'kb logs list', 'kb logs show <runId>', and 'kb logs compare'. compare defaults to last two runs; --command init narrows to init runs for before/after feature comparisons. Output is a stage-aligned delta table showing Δms, Δtokens in/out, and Δcost per stage. --since flag accepts 1h, 7d, or YYYY-MM-DD. All three wired into index.ts. (source: consumer)
