---
type: Spec
title: "Spec: TUI"
sources: [../../../kb-client/src/tui, ./TUI.md]
tests: [../../../../tests/tui]
description: Behavioral specification for TUI
tags: [spec, kb]
timestamp: 2026-06-28T04:05:30Z
---

### Intro

Behavioral requirements. Architecture: [TUI.md](TUI.md).

### Definitions

See companion doc for full vocabulary where applicable.

### Scope

## In Scope
- Unit-tested behaviors in the FR/TC tables below

## Out of Scope
- See related companion docs for architectural boundaries

### Functional Requirements

| ID | Requirement |
| ------ | ------------ |
| FR-1 | Behaviors in base-refresh.test.ts |
| FR-2 | Behaviors in chat-io-classify.test.ts |
| FR-3 | Behaviors in chat-read-kind.test.ts |
| FR-4 | Behaviors in history-pane.test.ts |
| FR-5 | Behaviors in init-args.test.ts |
| FR-6 | Behaviors in init-progress-line.test.ts |
| FR-7 | Behaviors in init-status.test.ts |
| FR-8 | Behaviors in loading-spinner.test.ts |
| FR-9 | Behaviors in partition-shell-output.test.ts |
| FR-10 | Behaviors in runner.test.ts |
| FR-11 | Behaviors in slash-commands.test.ts |

### QA Test Cases

| Test ID | Requirement | Scenario | Expected Outcome |
| --------- | ------------ | ---------- | ------------------ |
| TC-1 | FR-1 | Given an async refreshBase, then startSession sees the updated value | pass |
| TC-2 | FR-1 | Given refreshBase not awaited, then startSession would see stale value (regression scenario) | pass |
| TC-3 | FR-1 | Given refreshBase rejects, then error propagates and startSession is not called | pass |
| TC-4 | FR-2 | has the three expected tier values | pass |
| TC-5 | FR-2 | classifies orchestration wire lines as META | pass |
| TC-6 | FR-2 | classifies init/scan progress lines as META | pass |
| TC-7 | FR-2 | preserves full wire line as content for META | pass |
| TC-8 | FR-2 | strips assistant> prefix and classifies as ASSISTANT | pass |
| TC-9 | FR-2 | does NOT classify assistant> as META | pass |
| TC-10 | FR-2 | classifies plain text as ASSISTANT | pass |
| TC-11 | FR-2 | handles multiline assistant content (full body as single write) | pass |
| TC-12 | FR-2 | classifies blank lines as SKIP | pass |
| TC-13 | FR-2 | returns empty content for SKIP | pass |
| TC-14 | FR-2 | classifies assistant> with blank body as SKIP | pass |
| TC-15 | FR-3 | classifies the idle you> prompt as chat | pass |
| TC-16 | FR-3 | classifies non-idle prompts as command prompts | pass |
| TC-17 | FR-3 | uses the first non-empty line for multiline prompts | pass |
| TC-18 | FR-3 | starts pending only for non-slash chat turns | pass |
| TC-19 | FR-3 | does not start pending for slash commands | pass |
| TC-20 | FR-3 | does not start pending for command/interview prompt answers | pass |
| TC-21 | FR-4 | keeps completed rows in static and loading rows live | pass |
| TC-22 | FR-4 | returns empty liveItems when nothing is loading | pass |
| TC-23 | FR-4 | loading entry in the middle stays in liveItems while surrounding statics go to staticItems | pass |
| TC-24 | FR-4 | once answer is committed it appears in staticItems at its array position | pass |
| TC-25 | FR-5 | Given scan args without --base and fallback exists, then appends --base fallback | pass |
| TC-26 | FR-5 | Given --base already provided, then preserves original args | pass |
| TC-27 | FR-5 | Given empty fallback and no --base, then leaves args unchanged | pass |
| TC-28 | FR-6 | extracts repo slug and progress body | pass |
| TC-29 | FR-6 | returns the full line when no repo prefix is present | pass |
| TC-30 | FR-6 | passes through init prompts unchanged | pass |
| TC-31 | FR-7 | routes init progress lines away from transcript history | pass |
| TC-32 | FR-7 | keeps kb init questions in the main transcript history | pass |
| TC-33 | FR-7 | uses the last init progress line when multiple updates arrive together | pass |
| TC-34 | FR-7 | keeps ast-facts totals inside the progress line without requiring a separate action row | pass |
| TC-35 | FR-8 | returns empty array for undefined | pass |
| TC-36 | FR-8 | returns empty array for empty string | pass |
| TC-37 | FR-8 | returns empty array for whitespace-only string | pass |
| TC-38 | FR-8 | returns single non-empty line | pass |
| TC-39 | FR-8 | keeps at most ${SPINNER_MAX_LINES} lines (tail) | pass |
| TC-40 | FR-8 | truncates lines longer than ${SPINNER_MAX_LINE_LEN} chars with ellipsis | pass |
| TC-41 | FR-8 | does not truncate lines at exactly the limit | pass |
| TC-42 | FR-8 | filters blank lines | pass |
| TC-43 | FR-8 | trims trailing whitespace from lines | pass |
| TC-44 | FR-8 | respects custom maxLines and maxLineLen params | pass |
| TC-45 | FR-8 | a large streaming document only shows the tail — prevents scrollback overflow | pass |
| TC-46 | FR-9 | output with no meta lines → one body segment | pass |
| TC-47 | FR-9 | empty output → no body segments | pass |
| TC-48 | FR-9 | only meta lines → no body segments | pass |
| TC-49 | FR-9 | meta line splits body into two segments | pass |
| TC-50 | FR-9 | evidence> summary is a single meta line after the answer | pass |
| TC-51 | FR-9 | assistant> lines are NOT meta — they are body | pass |
| TC-52 | FR-9 | emptyPrimaryContent is non-empty only when there is body content | pass |
| TC-53 | FR-9 | real-world /query output: stage lines are meta, answer prose is body | pass |
| TC-54 | FR-9 | first body segment index is stable so primary-first ordering works | pass |
| TC-55 | FR-10 | splits a plain command into tokens | pass |
| TC-56 | FR-10 | handles a double-quoted argument | pass |
| TC-57 | FR-10 | handles a single-quoted argument | pass |
| TC-58 | FR-10 | handles multiple quoted args | pass |
| TC-59 | FR-10 | ignores leading and trailing whitespace | pass |
| TC-60 | FR-10 | returns empty array for blank input | pass |
| TC-61 | FR-10 | handles an unclosed quote by appending the partial token | pass |
| TC-62 | FR-10 | captures log output from runMainWithOutput | pass |
| TC-63 | FR-10 | captures error output from runMainWithOutput | pass |
| TC-64 | FR-10 | captures write (streaming) output | pass |
| TC-65 | FR-10 | returns empty string when runMainWithOutput produces no output | pass |
| TC-66 | FR-10 | captures thrown errors as output text | pass |
| TC-67 | FR-10 | passes args through to runMainWithOutput | pass |
| TC-68 | FR-11 | shows slash suggestions when input starts with slash | pass |
| TC-69 | FR-11 | returns the full command list for chat mode | pass |
| TC-70 | FR-11 | does not include /chat in the command list (chat is the app itself now) | pass |
| TC-71 | FR-11 | returns no suggestions for non-slash input | pass |
| TC-72 | FR-11 | sanitizes tabs from the raw input value | pass |
| TC-73 | FR-11 | wraps suggestion selection downward | pass |
| TC-74 | FR-11 | wraps suggestion selection upward | pass |
| TC-75 | FR-11 | formats the chosen suggestion for explicit completion | pass |
| TC-76 | FR-11 | returns empty completion text when no suggestion is selected | pass |
| TC-77 | FR-11 | normalizes slash commands before handing off to the CLI runner | pass |
| TC-78 | FR-11 | leaves normal commands unchanged | pass |
| TC-79 | FR-11 | scrolls the visible suggestion window with the selected row | pass |
| TC-80 | FR-11 | suggests /skills when typing /sk | pass |
| TC-81 | FR-11 | suggests logs subcommands when typing /logs c | pass |
| TC-82 | FR-11 | suggests /facts list when typing /facts li | pass |
| TC-86 | FR-11 | shows /cancel only in init-flow contexts, not at idle | pass |
| TC-87 | FR-11 | completes multi-segment commands | pass |
| TC-88 | FR-11 | suppresses suggestions after complete path with trailing args | pass |

### Related docs

- [TUI.md](TUI.md)

