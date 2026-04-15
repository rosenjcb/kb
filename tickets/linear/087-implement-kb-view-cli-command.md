# Implement `kb docs` CLI command family

## Ticket ID
087

## Theme
local-kb / cli-ux

## Problem

Ticket 086 defines the `kb docs` browsing contract, but the runtime does not yet exist. Users still cannot list available documents or open a full document directly from the CLI after discovery.


- Add `kb docs list` and `kb docs view` argument parsing and help text to the CLI.
- Implement exact document ID lookup and `--title` lookup using the shared reader.
- Implement metadata-only listing with a simple `--limit` flag.
- Render human-readable stdout output for a single document.
- Add `--output json` support for machine-readable document output.
- Implement exit/error behavior for missing, ambiguous, and invalid invocations.
- Add focused tests for parser behavior, output format, and error handling.
- **Note:** The canonical document-browsing CLI contract is now `kb docs list` and `kb docs view`. Do not reference legacy `kb view`. `kb explain` and `kb invalidate` are valid commands, but they are separate concepts.

## Acceptance Criteria

- `kb docs list` prints a browsable document list.
- `kb docs view <document-id>` prints the full document to stdout.
- `kb docs view --title "<title>"` resolves exact title matches.
- `kb docs view --output json` emits one full document payload.
- Not-found and ambiguous lookups fail with documented exit behavior.
- Help text and examples mention `kb docs`.

## Dependencies

086

## Deliverables

- CLI runtime for `kb docs`
- Output formatter(s)
- Test coverage for view behavior

## Estimate
M

## Priority
High

---

## Implementation Plan

### Ship `kb docs list` and `kb docs view` on the shared reader path

#### Background
Ticket 086 established the document-browsing contract, but the runtime still needed to expose a real consumer CLI surface for listing documents and viewing a single stored document. The implementation also had to align with the final `kb docs` namespace decision rather than the earlier experimental top-level `kb list` / `kb view` shape.

#### Approach
Implement a dedicated `src/cli/view-cli.ts` module that owns parsing, rendering, and error handling for `kb docs list` and `kb docs view`, and wire it into `src/cli/index.ts` as the canonical document-browsing namespace. Reuse `MarkdownDocumentReader` for both commands so listing and viewing stay grounded in the same retrieval/storage path as the rest of the KB runtime. Keep `kb docs view` deterministic with exact document ID lookup by default and exact-title lookup through `--title`, while `kb docs list` provides a simple metadata enumeration surface with `--limit`. Update tests and help text so the code, docs, and ticket spec all agree on the final command family.

#### Examples / Specifications
Implemented command surface:

```bash
kb docs list [--base <name>] [--limit <n>] [--output human|json]
kb docs view <document-id> [--base <name>] [--output human|json]
kb docs view --title "<exact title>" [--base <name>] [--output human|json]
```

Implemented modules:

```text
src/cli/view-cli.ts
- parseListCommand()
- parseViewCommand()
- runListCommand()
- runViewCommand()
- printListHelp()
- printViewHelp()

src/cli/index.ts
- docs namespace dispatch
- help text updates
- legacy top-level kb list/view rejection messages
```

Human list output shape:

```text
# KB Documents
Base: dogfood
Count: 5

- kb-base-selection-and-usage (title="KB Base Selection and Usage"; type=reference; tags=cli,usage,environment; updated=...)
```

Human view output shape:

```text
# KB Base Selection and Usage
ID: kb-base-selection-and-usage
Type: reference
Tags: cli, usage, environment
Created: ...
Updated: ...
Base: dogfood

Use the `kb use` command...
```

#### Error Conditions / Edge Cases
- `kb docs view` with both positional ID and `--title` returns a non-zero error.
- `kb docs view` with no matching document returns `Document not found: ...`.
- `kb docs view --title` with multiple exact-normalized title matches returns ambiguity error code `2`.
- `kb docs list` rejects positional arguments and validates `--limit` as a positive integer.
- Unsupported output modes are rejected consistently for both list and view.
- Human `view` output strips the stored canonical markdown preamble so metadata is not duplicated in the rendered output.

#### Decisions Made
- ✅ Decided: Ship browsing under `kb docs`, not top-level `kb list` / `kb view`. → Rationale: one namespace better reflects one conceptual feature.
- ✅ Decided: Reuse `MarkdownDocumentReader` instead of adding a second document-reading path. → Rationale: avoids storage drift and keeps list/view aligned with KB retrieval behavior.
- ✅ Decided: Keep `list` metadata-only and `view` full-content. → Rationale: fast browsing and explicit transition to full document reads.
- ✅ Decided: Keep exact-title matching strict rather than fuzzy. → Rationale: avoids turning `view` into a second query surface.

#### Integration Points
- Implements the runtime deferred from ticket 086.
- Preserves compatibility with the broader CLI surface in `src/cli/index.ts`.
- Leaves ticket 088 as the follow-up for interactive/TUI browsing beyond plain stdout rendering.

#### Validation & Closure
This implementation establishes:
- ✅ Working `kb docs list` and `kb docs view` commands on the real CLI surface
- ✅ Focused tests covering parsing, list output, view output, not-found cases, and title ambiguity
- ✅ Live smoke validation against the dogfood base
- ✅ Help text and command examples updated to the final `kb docs` namespace

**Ticket 087 is now closed.**
