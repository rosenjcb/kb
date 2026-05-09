---
layout: default
title: Setting up your first knowledge base
date: '2026-05-09'
kb_id: setting-up-your-first-knowledge-base
tags:
  - docs-generate
categories:
  - howto
---

This document outlines how to set up your first knowledge base.

## Goal
Set up a knowledge base session for your repository and interact with it via chat.

## Prerequisites
An LLM API key must be exposed via environment variables.

## Steps
*   **Initialize your knowledge base:** Run `kb init` in your repository's root directory. This command creates the foundational knowledge base structure by setting up the `.kb-index.sqlite` database in your repository's root directory, which will store your knowledge.
*   **Add content to your knowledge base:** After initialization, you will need to add documents or other relevant content to your knowledge base using `kb add` commands.
*   **Start a chat session:** Once content is indexed, you can begin interacting with your knowledge base via chat by running `kb chat`.

## Verification
To confirm `kb init` was successful, verify that the `.kb-index.sqlite` file has been created in your repository's root directory.

After adding content, you can verify the overall setup by querying the knowledge base via chat or by using commands like `kb query`, `kb graph`, or `kb docs`. Note that `kb query` is designed for programmatic, one-shot retrieval by agents, whereas chat mode offers an iterative, user-facing conversational experience.

## References

- installSkillIntoProject() targets user profile-level MDs (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) rather than local repo CLAUDE.md/AGENTS.md. If neither profile MD exists, it creates ~/.claude/CLAUDE.md. The cwd parameter was removed from the function signature. — `fact://0c5223b17f53aab1`
- kb query is the agent-facing, one-shot retrieval command: it runs the full intent-rewrite pipeline, runQueryTruthRetrieval, and enrichReadDocumentsAnswerWithLLM in a single pass. It is designed for programmatic use — agents (Claude Code, Cursor, Codex) call it to get a complete answer they can act on immediately. Chat mode is the user-facing, iterative experience: it uses executeChatQueryTruthRetrieval with auto-deepening, live in-memory message history, and conversational turn resolution across multiple back-and-forth exchanges. The two paths are intentionally different and should not be collapsed — query is for machines needing a deterministic answer, chat is for humans building understanding over time. — `fact://c2bd509a11e0ca2f`
- - CLI wording should make this explicit: these are knowledge-base cleanup operations, not codebase refactors. — `fact://5c1acfe883057f35`
- - Source code, tests, and unrelated repo assets are out of scope unless a separate code-editing command explicitly owns that responsibility. — `fact://d30ad245d3660a52`
- - Scope must be limited to the active KB store, not arbitrary repo files. — `fact://6f6e71a313457782`
- For KB maintenance tools that mutate stored knowledge (for example `invalidate_fact` / `kb invalidate`): — `fact://b9b297900918b63b`
- - [ ] Examples exist for common use cases — `fact://3f3dcbb43d235ab2`
- This means a query for "KbGraphWriter" can still surface facts that mention "SQLite" or "property graph" if those edges exist in the graph — even when the literal query string did not include those words. — `fact://147979da16325171`
- The expanded term set is capped and concatenated to the original query for fact retrieval. — `fact://c6d9430a60abd141`
- For every live edge touching those entities, expansion adds **semantic triplets** as natural-language phrases (`Subject <predicate phrase> Object`, plus the stored predicate slug and a spaced variant, e.g. — `fact://ce5bc9af5d2198f3`
- - `weight`: 1.0 for live edges, 0 for soft-deleted edges (set by `kb invalidate`) — `fact://13573a3c8a36465a`
- - `type` on relationships: canonical extractor labels (`depends_on`, `contradicts`, `related_to`, `replaces`, `implements`, `uses`) **or** any snake_case label you set via `kb graph edge add --verb` (free text is normalized to snake_case for storage) — `fact://597b6f9d78afadf0`
- Graph tables live in **`<base-dir>/.kb-index.sqlite`** (`kb_graph_entities`, `kb_graph_relationships`), alongside documents, chunks, and facts. — `fact://23c53c80ec0ef2a6`
- **Session override:** Pass `--base <name>` on `kb graph` (same as other KB commands) to target a specific session without switching your active base. — `fact://e1581d19940acab2`
- **Export:** The full graph can be dumped as Graphviz DOT (for visualisation tools like Gephi or Mermaid) or JSON (for your own analysis). — `fact://4c1f106d8b475c1a`
- As you build up your knowledge base, the graph gives you a structural view of how ideas connect — something the flat SQLite full-text index cannot express. — `fact://ab58de76fc696b75`
- Your single responsibility is to execute the given instruction and report results clearly. — `fact://c6c17d89fd705933`
- - Your tool access is intentionally limited. — `fact://a1c152ed55b7852c`
- - The parent agent will integrate your output into a larger result. — `fact://a1e1d4415244387e`
- You expand short or vague knowledge-base queries into targeted sub-queries. — `fact://3447bc2f075af706`
