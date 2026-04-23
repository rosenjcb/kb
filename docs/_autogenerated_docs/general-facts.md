---
layout: default
title: General Facts
date: '2026-04-21'
kb_id: general-facts
tags:
  - general
  - fact
categories:
  - reference
---

## Agent Loops and Orchestration

The core `agentLoop` is an `AsyncGenerator<AgentEvent>` in `src/core/agent-loop.ts` that drives LLM tool-calling loops. It yields events such as `text`, `tool_start`, `tool_result`, `metadata`, and `done`, with a default `maxTurns` of 10. `agentLoop` is designed for scenarios where the LLM autonomously decides which tools to call over multiple data-driven turns. It is now for programmatic/SDK use only; the freeform `agentLoop` CLI path has been removed.

For comparison, a cycle loop (like `kb init` or `kb chat`) is used when the sequence of LLM calls is known ahead of time, while `provider.call()` is used directly for single LLM completions with no tools. The `AGENT_LOOP.md` document details these two primary loop patterns: the generic `agentLoop` for autonomous tool-calling, and domain-specific cycle loops. This document serves as a counterpart to `src/tools/TOOL_CONVENTIONS.md` for agent orchestration patterns.


## KB Init Process

The `kb init` command uses an iterative cycle loop to create knowledge base documents. Initially, it ran a 5-cycle interview loop, which has since been expanded to a 7-cycle loop:

1.  **read-inputs**: Scans source files (e.g., README/CLAUDE.md/AGENTS.md) and asks user interview questions via stdin. Interview questions are typed by topic (project-overview, install-setup, core-workflows, architecture, configuration, testing, deployment-release, constraints-gotchas) and reason (missing-topic, low-confidence, contradiction, needs-example). A maximum of 10 total questions are allowed, with a maximum of 4 follow-ups.
2.  **pass1 (synthesis)**: LLM synthesis of 5-15 candidate KB documents at temperature 0.2.
3.  **pass2 (follow-up + refinement)**: Topic coverage gap analysis, follow-up questions for weak topics, and LLM refinement at temperature 0.1. Topic coverage is assessed after each LLM pass using `assessTopicCoverage()`, which scores confidence as high/medium/low and status as sufficient/needs-follow-up/inferred-only/unresolved.
4.  **pass-enrich**: Each candidate document receives its own dedicated LLM call in parallel (`Promise.all`, temperature 0.15). This process receives the full source context plus Q&A for that specific document, fills gaps with concrete facts, removes internal redundancy, and ensures the document remains focused on a single topic.
5.  **pass-consolidate**: A consolidation agent merges overlapping documents.
6.  **pass3 (quality)**: LLM quality validation at temperature 0.0. This pass validates titles, removes short documents, and ensures uniqueness.
7.  **write**: Upserts all candidate documents to SQLite.

Each cycle checkpoints its state to `.tmp/kb-init/<base>-latest.checkpoint.json` before advancing. The loop supports `--resume`, `--detach`, `--stop-after`, and `--non-interactive` flags. The `kb init` cycle loop uses decreasing temperature across its main passes: 0.2 for synthesis (pass1), 0.1 for refinement (pass2), and 0.0 for quality validation (pass3).

## KB Chat and Retrieval

The `kb chat` command utilizes a tiered retrieval loop, distinct from the generic `agentLoop`. This process involves: shallow `read_documents` initially; if confidence is below 0.45, it attempts a recovery query; an LLM completion at temperature 0.15 follows; if the answer appears insufficient, it promotes to deep discovery (with a 3x limit); if still insufficient, it tries a focused evidence query; and finally, if evidence remains inadequate, an explicit message is surfaced. Insufficient evidence is detected by string matching against known LLM hedge phrases in `looksLikeInsufficientEvidenceAnswer()`.

Architecturally, `kb chat` has historically operated as a single-turn retrieval loop, appending a short transcript to the final answer prompt rather than a true conversational agent loop. Retrieval was driven solely by the current user input, meaning follow-up queries like "Yeah let's do the search" did not rewrite the retrieval query based on prior context. Conversation history was limited to 4 turns, held in an in-memory array and injected after retrieval. This contrasts with systems like Claude Code, which maintain full message history for queries, allow the model to emit tool_use blocks in a streaming loop, and append assistant/tool messages to persistent conversation state.

An experimental conversational `kb chat` retrieval feature has been implemented (on `feat/098-conversational-kb-chat`), controlled by `config.chat.experimentalConversationalRetrieval` or the `KB_CHAT_CONVERSATIONAL_RETRIEVAL` environment variable. This enhancement allows `kb chat` to track compact conversation state (including `recentTurns`, `activeTopic`, `lastUserGoal`, `lastRetrievalQuery`, `lastRetrievedDocIds`, `pendingFollowUp`, and `needsSearch`). It enables rewriting retrieval queries for confirmations and follow-ups, and records per-turn traces for evaluation. While live evaluations showed significant improvement in follow-up search scenarios (e.g., a baseline score of 1 vs. conversational score of 3 for query iteration), `submit` and `invalidate` scenarios still favored the baseline, indicating that while retrieval memory aids iteration, it doesn't yet universally improve grounded updates.

## KB Query

The `kb query` command uses semantic search to find related documents in the knowledge base.

## KB Base Management

The `kb use <base>` command no longer writes to a `session.json` file. Instead, it prints an `export KB_BASE=<base>` instruction for the user to run, making `KB_BASE` an environment variable the session override mechanism. The KB base resolution priority is: (1) the `KB_BASE` environment variable (session-scoped, cleared on terminal close); (2) `config.selectedBase` in `~/.kb/config.json` (a persistent default set by `kb default`); (3) if neither is set, an error is thrown. The `session.json` file has been removed, and any references to the `writeSessionBase` function are now dead code.

## KB User Interface (TUI)

The KB Text User Interface (TUI) is built using Ink (React for terminals). It uses a color scheme of blue (#4FC3F7) as primary and orange (#FF7043) as secondary. The layout consists of a `StatusBar` at the top, a `HistoryPane` in the middle, and an `InputBar` at the bottom. Running `kb` with no arguments in a TTY launches the TUI, while `kb <command>` still functions as a one-shot CLI.

The TUI's entry point is `src/tui/index.tsx`, which renders `App.tsx` via Ink. The application state, including history entries, `TuiMode` (shell or chat), `baseName`, and `isRunning` status, resides within `App.tsx`. The `chat` mode uses a `ChatIO` adapter pattern, with the `runChatSession` logic from `chat-cli.ts` remaining unchanged. All CLI commands are reachable within the TUI via `runCommandForTui()` in `runner.ts`.

## Graph Storage

`DuckGraphWriter` uses DuckDB to store entities and relationships as a property graph.

## Telemetry and Evaluation


A `TokenCountingProvider` wraps any `LLMProvider` to accumulate `inputTokens` and `outputTokens` across all `.call()` invocations, with counts retrievable via `getAndReset()` per cycle. For `kb init`, a single counting provider is used and reset between each `InitCycle` (e.g., pass1 to pass-graph). For intent commands, the provider is wrapped in `index.ts`, and tokens from LLM calls for graph-extraction (during `submit`) and answer-enrichment (during `query`) are flushed
