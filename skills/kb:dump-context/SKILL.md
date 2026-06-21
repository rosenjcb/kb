---
name: kb:dump-context
description: >-
  Is the user asking me to write in-place companion docs near code — README-tier
  knowledge (purpose, integration, invariants) that expand on the implementation?
  Files like TUI.md or INTENTS.md that kb scan ingests later. Author them in the
  Open Knowledge Format (OKF): YAML frontmatter + markdown body.
---

# KB Dump Context

Write companion docs beside the code they describe, in the **Open Knowledge Format
(OKF)** — the LLM-wiki standard kb encourages. `kb init` / `kb scan` ingest these
files as source material for the KB; they recognize OKF frontmatter and skip the
metadata block, indexing the document body like any markdown.

**Sources:** Open files, Read/Grep/Glob, user-named paths, and conversation scope — disk and session context only.

## OKF format (required)

Every companion doc is an OKF concept file: a YAML frontmatter block followed by a
markdown body.

```markdown
---
type: Subsystem                         # REQUIRED — the concept kind, your choice of wording
title: TUI Renderer                     # human-readable name
description: Drives the Ink session loop and frame diffing.  # one sentence
resource: ./session.tsx                 # path/URI to the code this describes
tags: [tui, rendering]                  # categorization for retrieval
timestamp: 2026-06-20T00:00:00Z         # ISO 8601 of last change
---

# TUI Renderer

One-paragraph what/why …
```

- **`type` is the only mandatory field.** Pick a descriptive value (`Subsystem`,
  `Module`, `Playbook`, `CLI Command`, `Contract`, …). Recommended fields above
  improve retrieval — include them when known, omit when not.
- kb tolerates non-OKF markdown too, so an incomplete file is never rejected — but
  default to writing valid OKF so docs stay portable and consistently structured.

## Body tier

Bridge reading the code and working in the system: purpose, integration boundaries, invariants, extension checklists, gotchas, and links to sibling docs (e.g. `../core/TUI.md`). Lead with why the package exists, who calls it, and the single supported path for important operations.

**Output caps:** ≤80 lines and ~600 words of body per file (frontmatter excluded). Technical README tone.

**Mermaid:** One `flowchart LR` or `sequenceDiagram` in Role or Integration when the flow has 3+ actors or stages.

**Invariants:** One imperative, testable rule per bullet.

## When to invoke

- “Dump context”, document a subsystem, or create `TUI.md`-style companions
- Capture in-place architecture after substantive changes

## Protocol

1. Confirm scope — one doc per subsystem directory.
2. Inventory entry files and callers from disk.
3. Update existing `SCREAMING_SNAKE_CASE.md` when present — add OKF frontmatter if it lacks any.
4. Draft frontmatter (at minimum `type`) + body from the template; omit empty sections.
5. Review — each paragraph adds knowledge beyond what identifiers in code already convey.

## Naming

Place `INTENTS.md`, `CLI.md`, and similar names in the directory they describe. Product-wide contracts may live in `src/core/`; implementation detail stays local. OKF reserves `index.md` (directory listing) and `log.md` (update history) — do not use those names for concept docs.

## Template

Frontmatter (`type` + recommended fields) → `# Title` → one-paragraph what/why → **Role in the stack** (fit, boundaries, optional mermaid) → **Core pieces** (non-obvious file roles) → **Integration** (callers, deps, config, canonical entrypoints) → **Invariants** (one rule per bullet) → **Extension checklist** → **Gotchas** → **Related docs** (relative links). OKF conventional headings (`# Schema`, `# Examples`, `# Citations`) are welcome where they fit.

## Review passes

1. Expansion — purpose, integration, mermaid, invariants, checklist.
2. Compression — keep non-obvious value only.
3. Cap — ≤80 lines, ~600 words body, one invariant per bullet, valid OKF frontmatter with a non-empty `type`.

## Multi-area

Propose 3–8 boundaries; start with entrypoints and routers; one file per area with cross-links.

## Done when

Each doc carries OKF frontmatter with a `type`, and the reader can state why the directory exists, which rules govern changes, where to add new work, and the canonical path for key operations.
