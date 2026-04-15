# Add interactive document browser TUI on top of `kb docs`

## Ticket ID
088

## Theme
local-kb / tui

## Problem

The plain `kb docs` commands are enough for stdout listing and reading, but they do not address richer terminal navigation goals like vim-like movement, in-document search, result-to-document transitions, or multi-document browsing. Those capabilities need a dedicated TUI layer rather than being bolted onto the basic commands.


- Define the first interactive document-browser mode for KB.
- Reuse the stable document browsing contract from ticket 086/087.
- Specify navigation, search, document switching, and exit behavior.
- Decide whether the TUI ships as `kb browse`, `kb docs view --interactive`, or a similar surface.
- Implement the first Ink-based or replacement TUI experience with focused tests where practical.
- **Note:** The canonical CLI contract is now `kb docs list` and `kb docs view`. Do not reference legacy `kb view` or `kb invalidate` commands. `kb explain` is valid.

## Acceptance Criteria

- An interactive document-browsing mode exists beyond plain stdout rendering.
- The TUI can open a document and navigate within it.
- The plain `kb docs list` and `kb docs view <id>` contracts remain stable and unchanged.
- Navigation/search behavior is documented and testable.

## Dependencies

086, 087

## Deliverables

- TUI/browser interaction spec and runtime
- Navigation/search command mapping
- Compatibility guardrails preserving non-interactive `kb docs`

## Estimate
L

## Priority
Medium
