---
name: kb:dump-context
description: >-
  Is the user asking me to write in-place companion docs near code — README-tier
  knowledge (purpose, integration, invariants) that expand on the implementation?
  Files like TUI.md or INTENTS.md that kb-server indexing ingests later. Author OKF companions
  and, when a sibling *.spec.md exists or behavior changed, update the behavioral
  spec per the spec.md framework (FR/TC tables).
---

# KB Dump Context

Write **two-layer docs** beside the code they describe:

| Layer | File | `type` | Purpose |
|-------|------|--------|---------|
| **Companion** | `SUBSYSTEM.md`, `CLI.md`, … | `Subsystem`, `Module`, `Guide`, … | Architecture — why, integration, invariants, gotchas |
| **Behavioral spec** | `*.spec.md` | `Spec` | Testable requirements — **FR-N** + **TC-N** tables |

Both extend [OKF](https://github.com/rosenjcb/okf) (YAML frontmatter + markdown body). The [spec.md framework](https://github.com/rosenjcb/spec.md) adds the FR/TC structure on top of OKF for `*.spec.md` files. kb-server indexing ingests both; OKF frontmatter is skipped at index time.

**Sources:** Open files, Read/Grep/Glob, user-named paths, and conversation scope — disk and session context only.

## When you see `*.spec.md`

**Always read the sibling spec first** when documenting or changing a subsystem that already has one (e.g. `CLI.md` ↔ `CLI.spec.md`, `EVAL.md` ↔ `EVAL.spec.md`). Follow its structure and numbering — do not invent a parallel requirements format.

- **Companion** = narrative architecture; link to the spec under **Related docs**.
- **Spec** = behavioral contract; intro links back to the companion for stack context.
- **Split rule:** if a statement is testable ("when X, then Y"), it belongs in the spec as FR/TC; the companion states *why* and *where*, not duplicate acceptance criteria.
- After adding or extending a spec, declare the tests it governs in its own `sources:` frontmatter (repo has no central manifest — `spec:check` derives per-spec scope from `sources:`) and ensure tests use `[TC-N]` tags per [`TESTING.md`](../../TESTING.md). Run `pnpm run spec:check` when tests exist.

If no `*.spec.md` exists yet and the area has unit-tested behavior worth gating, propose creating one — but do not block companion work on it.

## OKF companion format

```markdown
---
type: Subsystem
title: TUI Renderer
description: Drives the Ink session loop and frame diffing.
resource: ./session.tsx
tags: [tui, rendering]
timestamp: 2026-06-20T00:00:00Z
---

# TUI Renderer

One-paragraph what/why …
```

- **`type` is mandatory** — never `Spec` on a companion (that belongs on `*.spec.md`).
- Recommended fields (`title`, `description`, `resource`, `tags`, `timestamp`) improve retrieval; omit when unknown.
- kb tolerates non-OKF markdown, but default to valid OKF.

### Companion body template

`# Title` → one-paragraph what/why → **Role in the stack** (optional mermaid) → **Core pieces** → **Integration** → **Invariants** (one imperative rule per bullet) → **Extension checklist** → **Gotchas** → **Related docs** (include `→ [FOO.spec.md](./FOO.spec.md)` when a spec exists).

**Caps:** ≤80 lines, ~600 words body (frontmatter excluded). One `flowchart LR` or `sequenceDiagram` when flow has 3+ actors.

## spec.md format (`*.spec.md`)

```markdown
---
type: Spec
title: "Spec: Fact Curator"
sources: ./fact-curator.ts,../../tests/tools/fact-curator.test.ts
description: Post-retrieval relevance curation
resource: ./fact-curator.ts
tags: [spec, kb]
timestamp: 2026-06-28T00:00:00Z
---

### Intro

One paragraph + link to companion: [FACT_CURATOR.md](./FACT_CURATOR.md).

### Definitions

Domain terms not obvious from code.

### Scope

## In Scope
- …

## Out of Scope
- … (point to companion or other specs)

### Functional Requirements

| ID | Requirement |
|------|------------|
| FR-1 | … |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
|---------|------------|----------|------------------|
| TC-1 | FR-1 | Given … | … |
```

- Continue **FR-N** / **TC-N** numbering from the existing spec — never renumber or reset.
- Every new **TC-N** row needs a matching `[TC-N]` test (agent may note the gap; user or a follow-up adds the test).
- `sources` frontmatter lists implementation + test paths the spec governs.

## When to invoke

- “Dump context”, document a subsystem, or refresh companions after substantive changes
- Behavior changed → update companion **and** sibling `*.spec.md` FR/TC rows

## Protocol

1. **Confirm scope** — one companion per subsystem directory; check for existing `*.spec.md`.
2. **Inventory** — entry files, callers, governing tests (`tests/<area>/`).
3. **Read existing docs** — update in place; add OKF frontmatter if missing.
4. **Draft companion** — architecture only; cross-link spec.
5. **Update spec** (if present or warranted) — new/changed FR rows + TC rows; manifest entry if new.
6. **Review** — companion adds knowledge beyond identifiers; spec rows are testable and traceable.

## Naming

| Pattern | Example | Notes |
|---------|---------|-------|
| Companion | `CLI.md`, `FACT_CURATOR.md`, `EVAL.md` | In the directory described |
| Spec | `CLI.spec.md`, `FACT_CURATOR.spec.md` | Sibling to companion |
| Reserved | `index.md`, `log.md` | OKF reserved — do not use for concept docs |

Product-wide contracts may live in `src/core/`; implementation detail stays local.

## Review passes

1. **Expansion** — purpose, integration, mermaid, invariants; spec FR/TC for changed behavior.
2. **Compression** — drop prose that restates code or duplicates spec rows.
3. **Cap** — companion ≤80 lines / ~600 words; spec tables stay concise.

## Multi-area

Propose 3–8 boundaries from entrypoints; one companion (+ spec if applicable) per area with cross-links.

## Done when

- Companion has OKF frontmatter (`type` ≠ `Spec`) and answers: why this directory exists, canonical paths, invariants.
- Sibling `*.spec.md` (if any) reflects current behavior; intro links to companion; new TC rows noted for test follow-up.
- **Related docs** cross-link companion ↔ spec.
