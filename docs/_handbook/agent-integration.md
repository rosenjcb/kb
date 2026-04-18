---
layout: default
title: Agent Integration
nav_order: 50
---

# Agent Integration

KB is designed to work alongside AI coding agents — Cursor, Claude Code, GitHub Copilot, and others. You can install a reusable agent skill that teaches your agent when and how to use KB during development.

---

## The KB Dev Workflow Skill

KB ships a self-contained agent skill at:

```
examples/agent-skills/kb-dev-workflow/SKILL.md
```

The skill teaches the agent:

- When to query KB before making a change
- When to submit a new fact after a decision
- How to validate assumptions against KB evidence
- When to dispute outdated facts rather than silently overwriting them

### Install in Cursor

Copy the skill directory into your repo:

```bash
cp -r examples/agent-skills/kb-dev-workflow .cursor/skills/
```

The file must end up at `.cursor/skills/kb-dev-workflow/SKILL.md`.

### Install in Claude Code

Import the skill body into your project's `CLAUDE.md` or `AGENTS.md`, or reference the file directly if your Claude Code version supports skill files.

### Other agents

The skill is plain Markdown with YAML frontmatter. Import the body into whatever "rules" or "context" format your tool expects.

---

## Dogfood workflow (recommended)

When using KB inside your own project's development loop:

```bash
# 1. Before a change — pull relevant context
kb query "the area you're about to modify" --limit 5

# 2. After a decision — record it
kb submit "chose approach X over Y because Z" --domain <area>

# 3. Sanity-check an assumption
kb validate "the claim you're about to act on"

# 4. When you find a stale fact
kb dispute "the outdated claim" --because "what's true now"
```

Use a named base for your project's persistent knowledge:

```bash
kb use --default myproject
```

Use disposable `ci-*` bases for automated test runs so they don't pollute the main base:

```bash
kb init --base ci-e2e-test --non-interactive
```

---

## Intent-first principle

Prefer intent commands over freeform prompts when integrating KB into an agent loop:

| Instead of… | Use… |
|---|---|
| Asking KB to "write a document about X" | `kb submit "fact about X"` |
| Asking KB to "search for Y" | `kb query "Y"` |
| Asking KB to "check if Z is still true" | `kb validate "Z"` |

Intent commands are structured, auditable, and avoid side-effects outside KB.

---

## Using the KB SDK in TypeScript

KB exposes its core primitives as importable modules so you can embed knowledge retrieval into your own TypeScript programs or agents.

### Run an intent

```typescript
import { DefaultIntentRouter } from 'kb-agent-harness/intents/router'
import { createKBToolsRegistry } from 'kb-agent-harness/tools/kb-tools-registry'

const toolExecutor = createKBToolsRegistry({ baseDir: '~/.kb/sessions/myproject' })
const router = new DefaultIntentRouter(toolExecutor)

const result = await router.execute({
  intent: 'query_truth',
  query: 'how does auth token refresh work?',
  discoveryDepth: 'shallow',
  limit: 5,
})
```

### Run the intent loop (with retry + LLM)

```typescript
import { runIntentLoop } from 'kb-agent-harness/core/intent-loop'

const { result, iterations, escalated } = await runIntentLoop(
  { intent: 'validate_fact', fact: 'tokens expire after 15 minutes' },
  toolExecutor,
  { provider: myLLMProvider }
)
```

### Low-level agent loop

```typescript
import { agentLoop } from 'kb-agent-harness/core/agent-loop'

for await (const event of agentLoop('summarise the auth documents', provider, toolExecutor, { maxTurns: 5 })) {
  if (event.type === 'text') process.stdout.write(event.content)
  if (event.type === 'done') break
}
```

---

## Roadmap

We plan to ship a `kb install-skill` command (or equivalent installer flow) that automatically drops the right skill file into your project for Cursor, Claude Code, and other common coding agents — so manual copying is optional.
