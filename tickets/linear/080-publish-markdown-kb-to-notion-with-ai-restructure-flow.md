# Publish markdown KB to Notion with AI workspace restructuring flow

## Ticket ID
080

## Theme
notion

## Problem
Current KB markdown documents are optimized for internal, terse, agent-readable workflows. When imported manually into Notion, the result is usually a flat or low-quality structure. Notion AI often reformats file shells instead of truly reimagining and reorganizing content into a human-readable workspace.

## Scope
- Define a publish flow that exports current markdown docs into a deterministic zip bundle.
- Define an import target strategy in Notion (initial landing zone under Archive for safe staging).
- Define a guided Notion AI transformation step that rewrites and reorganizes content quality-first (not file-structure-first).
- Define required prompts/instructions for repeatable Notion AI outcomes.
- Define validation checks to verify readability, hierarchy quality, and source traceability after import.

## Non-Goals
- Building full bidirectional sync between markdown and Notion.
- Replacing markdown as source of truth.
- Automatic irreversible cleanup or deletions in existing Notion spaces.

## Acceptance Criteria
- A CLI-capable publish spec exists for three phases:
  1. Zip markdown payload (with manifest + metadata).
  2. Import payload into a predictable Notion staging location.
  3. Trigger guided AI restructuring prompt sequence for human-readable workspace output.
- Publish output includes deterministic artifact metadata:
  - source base
  - included/excluded file counts
  - zip checksum
  - publish timestamp
  - destination page URL/id
- Notion import location is explicitly scoped to Archive staging (safe to review/move later).
- AI prompt strategy is defined to force content-first reorganization (not naive list grouping).
- Validation checklist exists for:
  - information architecture quality
  - readability rewrite quality
  - provenance preservation
  - rollback safety

## Dependencies
022
023
026
043

## Deliverables
- Final ticket spec in this file.
- Prompt pack (primary + fallback) embedded in this ticket for operator reuse.
- Suggested CLI contract for follow-up implementation ticket.

## Estimate
L

## Priority
High

---

## Proposed Workflow (v1)

### Phase A: Package
- Build zip artifact from markdown source root: `sessions/namespaces/<base>/documents`.
- Include `manifest.json` with file list, title heuristics, tags, modified times, and checksum.
- Exclude binary index artifacts (for example SQLite index files).

### Phase B: Import
- Import zip into Notion Archive staging area:
  - `Knowledge base / Archive / Zip Imports / <YYYY-MM-DD> <base>`
- Do not publish into final navigation directly.

### Phase C: AI Restructure
- Run a strict Notion AI prompt that:
  - reorganizes by human mental model (overview, how-to, architecture, policies, changelog/archive),
  - rewrites for readability and context,
  - preserves factual fidelity and source references,
  - avoids mirroring raw file boundaries as final IA.

### Phase D: Review + Promote
- Human review in Archive staging.
- Move approved pages into final workspace sections.
- Keep raw import and AI-transformed version for diff/audit in first iteration.

## Suggested CLI Contract (for follow-up build ticket)

```bash
kb notion publish \
  --base dogfood \
  --stage-path "Knowledge base/Archive/Zip Imports" \
  --zip-out .tmp/notion-publish/dogfood-2026-04-12.zip \
  --dry-run

kb notion publish \
  --base dogfood \
  --stage-path "Knowledge base/Archive/Zip Imports" \
  --apply
```

Return payload sketch:

```json
{
  "status": "accepted",
  "artifact": {
    "zipPath": ".tmp/notion-publish/dogfood-2026-04-12.zip",
    "sha256": "...",
    "includedCount": 42,
    "excludedCount": 3
  },
  "notion": {
    "stagePageId": "...",
    "stagePageUrl": "..."
  },
  "nextAction": "run_notion_ai_prompt_pack"
}
```

## Notion AI Prompt Pack (initial draft)

### Prompt 1: Restructure + Rewrite (Primary)
Use this right after zip import completes and while focused on the imported parent page.

```text
You are reorganizing imported technical markdown into a polished, human-readable Notion knowledge workspace.

Critical instructions:
1) Do NOT keep the imported file/folder layout as-is.
2) Reorganize by human information architecture, not by source filenames.
3) Rewrite content for clarity and onboarding readability while preserving factual meaning.
4) Keep source provenance: include "Source" references at section/page level when facts are specific.
5) Preserve all important facts; remove duplication and merge overlapping notes.
6) Produce a concise top-level navigation with these sections:
   - Overview
   - Getting Started / CLI Guide
   - Retrieval & Indexing
   - Policies & Decisions
   - Ticket Timeline (high level)
   - Archive (raw imports + deprecated detail)
7) For each section, create a short summary page first, then child pages for detail.
8) Convert terse bullet dumps into readable explanations, checklists, and stepwise guides.
9) Prefer headings, callouts, and tables where useful; avoid giant flat bullet lists.
10) Keep uncertain or low-confidence statements explicitly marked as "Needs verification".

Output requirements:
- Build the new hierarchy directly under this imported page.
- Keep a "Raw Import" sub-page untouched for rollback/audit.
- Create an "Overview" landing page that explains what this KB is, how data is stored, and how to navigate.
```

### Prompt 2: Quality Pass (Fallback / second pass)
Use this after Prompt 1 completes.

```text
Perform a quality pass on the current Notion knowledge workspace.

Goals:
- Improve readability and flow for a new engineer with no prior context.
- Reduce repetition across pages.
- Ensure each top-level section has:
  1) purpose,
  2) key actions,
  3) links to detailed child pages.
- Ensure command examples are concrete and copy-pastable.
- Ensure architecture pages explain "why" decisions were made, not only "what".
- Keep technical precision; do not invent behavior.

Required checks:
- Add a short "How to use this workspace" block to the Overview page.
- Verify every major page has a last-updated note and source context.
- Flag pages that should remain in Archive instead of primary navigation.
```

## Open Questions / User Decisions
- Should v1 run as fully automated (API-based import + prompt execution) or semi-automated (CLI package + operator-driven Notion AI step)?
- Should prompt execution be single-pass only or enforced two-pass (restructure + quality pass)?
- Should archive staging path be fixed by policy or configurable per publish?

## Recommended Defaults
- Default mode: semi-automated for v1 (more controllable while Notion AI behavior is variable).
- Prompt mode: two-pass (structure first, quality second).
- Stage path: fixed default under Archive with override flag.
