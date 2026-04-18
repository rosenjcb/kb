---
layout: default
title: KB — Local-First Knowledge for AI Workflows
---

# KB

KB is a local-first knowledge system built for AI-assisted development. It gives you a CLI and runtime for storing durable facts, querying them by intent, and keeping project knowledge close to your code.

```bash
kb submit "Auth tokens expire after 15 minutes, not 24 hours"
kb query "token expiry policy"
kb validate "refresh tokens are session-scoped"
```

---

## Why KB?

Every project accumulates decisions, constraints, and tribal knowledge that lives in Slack threads, PR comments, and people's heads. KB gives that knowledge a home with a queryable structure — so your AI agent (or you) can retrieve the right context before making a change.

**Store durable facts** — not ephemeral chat history. Facts are versioned in Git alongside your code.

**Query by intent** — `kb query`, `kb validate`, `kb dispute` understand what you're asking, not just what words you typed.

**Hybrid retrieval** — SQLite full-text search + vector-style ranking returns relevant docs even when phrasing differs between the query and the stored fact.

**Knowledge graph** — entities and relationships are extracted automatically, so you can ask "what depends on X?" and get a traversal, not just a keyword match.

---

## Quick Start

### 1. Install

```bash
pnpm install
npm run refresh:global
npm run which:kb   # should print the kb binary path
```

### 2. Configure your LLM

KB auto-detects whichever API key is in your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). To set a provider explicitly:

```bash
kb config set llm.provider anthropic
```

### 3. Set a knowledge base

```bash
kb use myproject            # use for this session
kb use --default myproject  # persist as the default base
```

Each base stores its SQLite index under `~/.kb/sessions/<base>/`.

### 4. Bootstrap from your docs

```bash
kb init
```

`kb init` reads your README, CLAUDE.md, and other project docs, then runs a multi-pass LLM pipeline to produce a set of focused, retrieval-ready fact documents. Takes 1–3 minutes for a typical repo.

### 5. Start using intent commands

```bash
kb query "how does authentication work?"
kb submit "OAuth tokens are short-lived; use the refresh endpoint after 15 min"
kb validate "the refresh token flow is described in the auth runbook"
kb dispute "passwords are hashed with MD5" --because "we use bcrypt, not MD5"
```

---

## Daily Workflow

```bash
# Before making a change — pull relevant context
kb query "topic I'm about to touch"

# After a decision — record it
kb submit "we chose option B because option A required a schema migration"

# Sanity-check an assumption
kb validate "the queue is eventually consistent"
```

---

## Next Steps

- [CLI Reference](cli-reference) — full command reference
- [Knowledge Graph](knowledge-graph) — entity/relationship extraction and traversal
- [Interactive Shell (TUI)](tui) — the `kb` interactive shell
- [Architecture](architecture) — how KB works internally
- [Agent Integration](agent-integration) — use KB inside Cursor, Claude Code, or any AI agent
