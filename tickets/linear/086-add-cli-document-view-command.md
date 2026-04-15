# Add CLI document view command for full document display

## Ticket ID
086

## Theme
local-kb / cli-ux

## Problem

KB can retrieve document summaries and answer questions, but it does not yet offer a direct CLI flow for opening and reading the actual stored documents themselves. This makes it awkward to inspect the full source material behind a query result, audit document formatting, or use KB as a practical day-to-day document browser.

The immediate need is a simple CLI surface that prints the full document to the terminal. Longer term, this should become the retrieval/display layer for a richer Ink-based TUI with modal navigation and document browsing behavior.

## Scope

- Define a user-facing CLI command for displaying a full document by ID or other clear selector.
- Specify the MVP terminal behavior where documents are printed directly to stdout.
- Define how document metadata and body content should be rendered in the initial CLI view.
- Define error behavior for missing documents, ambiguous selectors, and unsupported output modes.
- Clarify how this command relates to `kb query` results and how users move from retrieval to full-document viewing.
- Capture forward-compatible design constraints for a future Ink/TUI document viewer, without implementing the TUI in this ticket.

## Acceptance Criteria

- A clear CLI contract exists for viewing a full document from the KB.
- The MVP output format for terminal rendering is documented.
- Selector rules are explicit for document IDs and any supported lookup shortcuts.
- Error behavior is specified for not-found and ambiguous matches.
- The ticket clearly separates MVP print-to-screen behavior from future TUI work.
- Follow-up implementation work is identified if this ticket remains planning-only.

## Dependencies

054, 057, 059, 082

## Deliverables

- Ticket-level CLI contract for a document-view command.
- Initial output/rendering specification for terminal display.
- Forward-looking compatibility notes for a future Ink/TUI document browser.
- Follow-up implementation checklist or dependent tickets if needed.

## Estimate
M

## Priority
High

---

## Implementation Plan

### Define `kb docs` as the canonical document browsing namespace

#### Background
KB can already retrieve document matches through `kb query` and the internal `read_documents` tool, but there is no consumer-facing command that opens a single stored document and prints the full body. We need a stable CLI contract now that works in a plain terminal and can later become the backing read surface for a richer Ink/TUI document browser.

#### Scope of This Work (Phase Clarity)
- ✅ Phase 1 (Planning): Complete in this ticket
  - Define the `kb docs view` and `kb docs list` command contracts
  - Define selector behavior, output shapes, and exit/error semantics
  - Define how `kb docs` composes with `kb query`
  - Reserve forward-compatible constraints for a future TUI
- ⏳ Phase 2 (Implementation): Deferred
  - Implement `kb docs` runtime and tests in ticket 087
  - Implement Ink/TUI document browsing in ticket 088

#### Approach
Add a new top-level document namespace, `kb docs`, with separate subcommands for enumeration and single-document reading. `kb docs list` handles discovery of available documents, while `kb docs view` opens exactly one document. The MVP should still favor determinism over fuzzy convenience: exact document ID is the default selector for viewing, and exact title match is the only secondary shortcut. Under the hood, both commands should reuse the existing `read_documents` reader instead of inventing separate storage paths, so human-readable terminal output and machine-readable JSON stay grounded in the same retrieval result shape.

#### CLI Contract

```bash
kb docs list [--base <name>] [--limit <n>] [--output human|json]
kb docs view <document-id> [--base <name>] [--output human|json]
kb docs view --title "<exact title>" [--base <name>] [--output human|json]
kb docs --help
```

- `kb docs list` returns multiple document metadata records and accepts `--limit`.
- `kb docs view` returns exactly one document and accepts either `<document-id>` or `--title`.
- Default selector mode for `view` is exact document ID.
- `--title` opts into exact title matching for `view`.
- Default output mode is `human`.
- Supported output modes are `human` and `json`; any other mode is rejected.

#### Examples / Specifications

```bash
kb query "base selection" --limit 3 --output json
kb docs list --base dogfood --limit 20
kb docs view kb-base-selection-and-usage
kb docs view --title "KB Base Selection and Usage"
kb docs view kb-base-selection-and-usage --output json
```

Human output:

```text
# KB Base Selection and Usage
ID: kb-base-selection-and-usage
Type: reference
Tags: cli, usage, environment
Created: 2026-04-15T04:49:46.959Z
Updated: 2026-04-15T06:15:31.000Z
Source: dogfood

Use the `kb use` command to select a session base...
```

JSON output:

```json
{
  "document": {
    "metadata": {
      "id": "kb-base-selection-and-usage",
      "title": "KB Base Selection and Usage",
      "filePath": "kb-base-selection-and-usage",
      "createdAt": "2026-04-15T04:49:46.959Z",
      "updatedAt": "2026-04-15T06:15:31.000Z",
      "tags": ["cli", "usage", "environment"],
      "type": "reference"
    },
    "content": "Use the `kb use` command..."
  }
}
```

Internal mapping:

```ts
// view by ID
reader.queryDocuments({
  query: documentId,
  mode: 'id',
  limit: 1,
  includeContent: true,
})

// view by title
reader.queryDocuments({
  query: title,
  mode: 'title',
  limit: 2,
  includeContent: true,
})

// list
reader.queryDocuments({
  limit: 20,
})
```

#### Selector Rules
- `kb docs view <document-id>` performs exact ID lookup after the same slug normalization rules already used by storage.
- `kb docs view --title "<exact title>"` performs exact title lookup, not fuzzy substring disambiguation.
- `kb docs list` is the direct enumeration surface for browsing available documents.
- Query-result handoff is still explicit: users can discover documents with either `kb query` or `kb docs list`, then pass the returned `metadata.id` into `kb docs view`.
- MVP does not support `--tags`, ranked search, ordinal selection (`--pick 2`), or interactive chooser flows.

#### Error Conditions / Edge Cases
- Missing selector → print `kb docs view` usage help and exit non-zero.
- Both `<document-id>` and `--title` provided → error and exit non-zero.
- ID/title not found → print `Document not found: <selector>` and exit code `1`.
- Title selector returns multiple exact-normalized matches → print an ambiguity error listing candidate IDs/titles and exit code `2`.
- `kb docs list` with positional arguments → error and exit non-zero.
- Unsupported output mode → print `Unsupported output mode: <mode>. Use human or json.` and exit code `1`.
- Missing base / unreadable storage → preserve existing base-resolution and reader error behavior rather than inventing a new storage exception model.

#### Forward-Compatible TUI Constraints
- `kb docs list` and `kb docs view` must remain stable non-interactive stdout commands even after Ink/TUI work lands.
- Future TUI work should layer on top of the same single-document read contract rather than bypassing it.
- TUI navigation, vim-like keybindings, inline search, and document-to-document jumping are explicitly out of scope for MVP.
- If an interactive viewer is added later, it should ship as a separate mode or command (for example `kb docs browse` or `kb docs view --interactive`) without changing the plain `kb docs view <id>` behavior.

#### Decisions Made
- ✅ Decided: Group document browsing under `kb docs`. → Rationale: `list` and `view` are one concept with one namespace, not unrelated top-level verbs.
- ✅ Decided: Make exact document ID the default selector. → Rationale: deterministic and matches the existing retrieval metadata shape returned by `kb query`.
- ✅ Decided: Support exact title lookup only through `--title`. → Rationale: keeps shortcuts ergonomic without turning the command into a second fuzzy search surface.
- ✅ Decided: Add `kb docs list` as the simple metadata enumeration surface. → Rationale: document browsing should not require a semantic query when the user wants a directory-like view.
- ✅ Decided: Reuse `read_documents` with `includeContent: true`. → Rationale: one read path reduces drift between CLI, tests, and future TUI consumers.
- ✅ Decided: Keep MVP terminal-first and non-interactive. → Rationale: solves the immediate document-reading gap without blocking on TUI architecture.

#### Integration Points
- Depends on ticket 057 for consumer CLI expectations and ticket 059 for intent-first command patterns.
- Builds on the current `MarkdownDocumentReader` / `read_documents` capability already used by retrieval surfaces.
- Ticket 087 implements the `kb docs` command family, parser wiring, output formatting, and tests.
- Ticket 088 designs and implements the richer Ink/TUI browsing layer on top of the stable read contract from this ticket.

#### Validation & Closure
This implementation plan establishes:
- ✅ A clear CLI contract for viewing a full document from the KB
- ✅ Explicit selector rules for ID and title-based lookup
- ✅ Defined terminal and JSON output behavior for the MVP
- ✅ Clear not-found, ambiguity, and unsupported-mode error semantics
- ✅ Explicit separation between plain CLI viewing and future TUI work
- ✅ Deferred implementation work is tracked in follow-up tickets 087 and 088

**Ticket 086 is now closed.**
