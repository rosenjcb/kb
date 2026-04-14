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
- Define first-class CLI UX via `kb publish` (with Notion as v1 provider) so the workflow is easy to run end-to-end.

## Non-Goals
- Building full bidirectional sync between markdown and Notion.
- Replacing markdown as source of truth.
- Automatic irreversible cleanup or deletions in existing Notion spaces.

## Acceptance Criteria
- A CLI-capable publish spec exists for three phases:
  1. Zip markdown payload (with manifest + metadata).
  2. Import payload into a predictable Notion staging location.
  3. Trigger guided AI restructuring prompt sequence for human-readable workspace output.
- CLI supports top-level publish command shape:
  - `kb publish --base <base> --dry-run`
  - `kb publish --base <base> --apply`
  - optional `--phase package|import|restructure|all`
  - optional `--provider notion` (default `notion` in v1)
  - single command surface in v1 (`kb publish`)
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

## CLI UX Scope (v1)

Primary command:

```bash
kb publish --base dogfood --dry-run
kb publish --base dogfood --apply
```

Optional controls:

```bash
kb publish --base dogfood --phase package
kb publish --base dogfood --phase import --apply
kb publish --base dogfood --phase restructure --apply
kb publish --base dogfood --provider notion
kb publish --base dogfood --archive-path "Knowledge base/Archive/Zip Imports"
kb publish --base dogfood --prompt-pack notion-v1
```

Behavior notes:
- `--dry-run` computes and prints planned artifact/import actions without mutating Notion.
- `--phase restructure` is operator-assisted in v1: CLI outputs exact prompt text and target page context for Notion AI execution.
- `kb publish` is the only command surface in v1 for publishing workflows.

## Suggested CLI Contract (for follow-up build ticket)

```bash
kb publish \
  --base dogfood \
  --archive-path "Knowledge base/Archive/Zip Imports" \
  --zip-out .tmp/notion-publish/dogfood-2026-04-12.zip \
  --dry-run

kb publish \
  --base dogfood \
  --archive-path "Knowledge base/Archive/Zip Imports" \
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
  "nextAction": "run_notion_ai_prompt_pack",
  "operatorPrompt": {
    "pack": "notion-v1",
    "targetPage": "Knowledge base / Archive / Zip Imports / ...",
    "instructions": "Paste Prompt 1 then Prompt 2 in Notion AI"
  }
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

---

## Implementation Plan

### SPIKE Plan for `kb publish` Notion Integration (v1)

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket/PR
  - Canonical CLI UX defined as `kb publish` (Notion default provider)
  - End-to-end publish flow specified (package, import, restructure, review)
  - Prompt pack and validation rubric defined for repeatable Notion AI outcomes
- ⏳ Phase 2 (Implementation): Deferred to follow-up ticket
  - Implement `kb publish` command runtime and Notion API adapter wiring
  - Add zip manifest generation and staging import execution
  - Add tests and operator runbook validation
  - **Blocking ticket**: 081 (implement `kb publish` Notion runtime)

#### Background
The team wants a reliable way to publish terse internal markdown docs into a human-friendly Notion workspace without relying on brittle ad-hoc manual steps. Current manual Notion AI behavior is inconsistent and often preserves file shells instead of restructuring content meaningfully.

#### Approach
Ship a planning-first SPIKE that defines deterministic publish semantics and a constrained operator loop for Notion AI. The CLI entry point is `kb publish` with Notion as the default provider in v1. The runtime is split into explicit phases so operators can run dry-run previews and execute only needed steps. Restructure remains operator-assisted in v1, with CLI printing exact prompts and target context. The plan includes auditability requirements (artifact metadata, staging location, provenance) so the workflow is reviewable before broad automation.

#### Examples / Specifications

Canonical command examples:

```bash
kb publish --base dogfood --dry-run
kb publish --base dogfood --apply

kb publish --base dogfood --phase package
kb publish --base dogfood --phase import --apply
kb publish --base dogfood --phase restructure --apply
```

Execution pipeline (v1):

```text
kb publish
  -> phase: package (zip + manifest)
  -> phase: import (Notion Archive staging page)
  -> phase: restructure (operator-assisted prompt output)
  -> phase: review/promote (human gate)
```

Validation script guidance for follow-up implementation:

```bash
npm run build:cli
node dist/bin/kb.js publish --base dogfood --dry-run
```

#### Error Conditions / Edge Cases
- Missing Notion credentials in config: fail with explicit setup instructions and required keys.
- Archive path not found or inaccessible: fail with path diagnostics and permission hint.
- Zip creation succeeds but import fails: preserve artifact and emit retry-safe import command.
- Notion AI output low quality: keep Raw Import untouched and require human promote gate.
- Provider mismatch (`--provider` unsupported): fail fast with supported-provider list.

#### Decisions Made
- ✅ Decided: Canonical command is `kb publish` only in v1. -> Rationale: simpler UX and avoids unimplemented compatibility surface.
- ✅ Decided: Default provider is Notion in v1. -> Rationale: this ticket targets Notion-first publish workflow.
- ✅ Decided: Restructure is operator-assisted in v1. -> Rationale: Notion AI behavior variability still requires human control.
- ✅ Decided: Archive staging is mandatory before promote. -> Rationale: protects existing workspace IA and enables rollback.
- ✅ Decided: Default execution mode is semi-automated with two-pass prompting. -> Rationale: user selected option A for controllability and quality.
- ✅ Decided: Archive path policy is fixed default with override flag. -> Rationale: user selected option A for consistency with escape hatch.

#### User Decision Checkpoint (Required)
- Decision requested from user: finalize operational defaults before implementation ticket kickoff.
- Options presented:
  - A (recommended): default to semi-automated + two-pass prompts + fixed archive default with override flag.
  - B: default to fully automated where possible + two-pass prompts + fixed archive path.
  - C: default to package-only dry-run mode, require explicit per-phase apply for every run.
- User response: selected **A** for execution mode and **A** for archive-path policy.
- Follow-up: ticket 081 implementation should use selected defaults.

#### Integration Points
- `src/cli/index.ts`: add `publish` command surface and phase orchestration.
- `src/cli/base-selection.ts`: reuse configured base resolution for source path selection.
- `src/tools/`: add Notion publish runtime module(s) for zip, import, prompt-output contract.
- `scripts/build-cli.mjs`: use existing build path as validation script for manual dry-run checks.
- Follow-up ticket: `tickets/linear/081-implement-kb-publish-notion-runtime.md`.

#### Validation & Closure
This implementation plan establishes:
- ✅ Acceptance criteria are mapped to concrete phases and CLI behavior.
- ✅ Notion-first defaults and command boundaries are explicit.
- ✅ Risk controls (staging, raw import preservation, human promote gate) are codified.
- ✅ User decisions captured for execution defaults and archive-path policy.
- ✅ Follow-up implementation ticket created for deferred phase-2 runtime work.

**Ticket 080 is now closed.**
