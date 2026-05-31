---
layout: default
title: skills/kb:dump-context/SKILL.md
date: '2026-05-30'
kb_id: skills-kb-dump-context-skill-md
tags:
  - original-source
  - skills-kb-dump-context-skill-md
  - kb
categories:
  - reference
---

---
name: kb:dump-context
description: >-
  Is the user asking me to write in-place companion markdown near code — README-tier
  docs (purpose, integration, invariants) that expand on the implementation?
  Files like TUI.md or INTENTS.md for kb scan ingestion later.
---

# KB Dump Context

Write companion markdown beside the code it describes. `kb init` / `kb scan` ingest these files as source material for the KB.

**Sources:** Open files, Read/Grep/Glob, user-named paths, and conversation scope — disk and session context only.

## Readme tier

Bridge reading the code and working in the system: purpose, integration boundaries, invariants, extension checklists, gotchas, and links to sibling docs (e.g. `../core/TUI.md`). Lead with why the package exists, who calls it, and the single supported path for important operations.

**Output caps:** ≤80 lines and ~600 words per companion file. Technical README tone.

**Mermaid:** One `flowchart LR` or `sequenceDiagram` in Role or Integration when the flow has 3+ actors or stages.

**Invariants:** One imperative, testable rule per bullet.

## When to invoke

- “Dump context”, document a subsystem, or create `TUI.md`-style companions
- Capture in-place architecture after substantive changes

## Protocol

1. Confirm scope — one doc per subsystem directory.
2. Inventory entry files and callers from disk.
3. Update existing `SCREAMING_SNAKE_CASE.md` when present.
4. Draft from the template; omit empty sections.
5. Review — each paragraph adds knowledge beyond what identifiers in code already convey.

## Naming

Place `INTENTS.md`, `CLI.md`, and similar names in the directory they describe. Product-wide contracts may live in `src/core/`; implementation detail stays local.

## Template

`# Title` → one-paragraph what/why → **Role in the stack** (fit, boundaries, optional mermaid) → **Core pieces** (non-obvious file roles) → **Integration** (callers, deps, config, canonical entrypoints) → **Invariants** (one rule per bullet) → **Extension checklist** → **Gotchas** → **Related docs** (relative links).

## Review passes

1. Expansion — purpose, integration, mermaid, invariants, checklist.
2. Compression — keep non-obvious value only.
3. Cap — ≤80 lines, ~600 words, one invariant per bullet.

## Multi-area

Propose 3–8 boundaries; start with entrypoints and routers; one file per area with cross-links.

## Done when

The reader can state why the directory exists, which rules govern changes, where to add new work, and the canonical path for key operations.
