---
type: Spec
title: "Spec: TUI"
sources: [../../../kb-client/src/tui, ./TUI.md]
tests: [../../../../tests/tui]
description: Behavioral specification for TUI
tags: [spec, kb]
timestamp: 2026-08-19T21:10:00Z
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
| TC-ATPX | FR-1 | Given an async refreshBase, then startSession sees the updated value | pass |
| TC-92GT | FR-1 | Given refreshBase not awaited, then startSession would see stale value (regression scenario) | pass |
| TC-VFG5 | FR-1 | Given refreshBase rejects, then error propagates and startSession is not called | pass |
| TC-G85D | FR-2 | has the three expected tier values | pass |
| TC-B5OA | FR-2 | classifies orchestration wire lines as META | pass |
| TC-KS6O | FR-2 | classifies init/scan progress lines as META | pass |
| TC-RG7T | FR-2 | preserves full wire line as content for META | pass |
| TC-J4XM | FR-2 | classifies a source> line carrying an OSC-8 hyperlink as META | pass |
| TC-APKJ | FR-2 | strips assistant> prefix and classifies as ASSISTANT | pass |
| TC-WLF2 | FR-2 | does NOT classify assistant> as META | pass |
| TC-999B | FR-2 | classifies plain text as ASSISTANT | pass |
| TC-ZZZY | FR-2 | handles multiline assistant content (full body as single write) | pass |
| TC-6P72 | FR-2 | classifies blank lines as SKIP | pass |
| TC-M2H9 | FR-2 | returns empty content for SKIP | pass |
| TC-34P4 | FR-2 | classifies assistant> with blank body as SKIP | pass |
| TC-B5M7 | FR-3 | classifies the idle you> prompt as chat | pass |
| TC-05R9 | FR-3 | classifies non-idle prompts as command prompts | pass |
| TC-ITD4 | FR-3 | uses the first non-empty line for multiline prompts | pass |
| TC-EISD | FR-3 | starts pending only for non-slash chat turns | pass |
| TC-VZEF | FR-3 | does not start pending for slash commands | pass |
| TC-3DR5 | FR-3 | does not start pending for command/interview prompt answers | pass |
| TC-BVGM | FR-4 | keeps completed rows in static and loading rows live | pass |
| TC-T6L5 | FR-4 | returns empty liveItems when nothing is loading | pass |
| TC-74CT | FR-4 | loading entry in the middle stays in liveItems while surrounding statics go to staticItems | pass |
| TC-F4FA | FR-4 | once answer is committed it appears in staticItems at its array position | pass |
| TC-KM20 | FR-5 | Given scan args without --base and fallback exists, then appends --base fallback | pass |
| TC-NWQ7 | FR-5 | Given --base already provided, then preserves original args | pass |
| TC-NX7E | FR-5 | Given empty fallback and no --base, then leaves args unchanged | pass |
| TC-1N1D | FR-6 | extracts repo slug and progress body | pass |
| TC-5GYA | FR-6 | returns the full line when no repo prefix is present | pass |
| TC-LEF5 | FR-6 | passes through init prompts unchanged | pass |
| TC-Y4O9 | FR-7 | routes init progress lines away from transcript history | pass |
| TC-QO2H | FR-7 | keeps kb init questions in the main transcript history | pass |
| TC-119T | FR-7 | uses the last init progress line when multiple updates arrive together | pass |
| TC-1EXM | FR-7 | keeps ast-facts totals inside the progress line without requiring a separate action row | pass |
| TC-GQLE | FR-8 | returns empty array for undefined | pass |
| TC-L2TK | FR-8 | returns empty array for empty string | pass |
| TC-254C | FR-8 | returns empty array for whitespace-only string | pass |
| TC-XA5R | FR-8 | returns single non-empty line | pass |
| TC-FN2H | FR-8 | keeps at most ${SPINNER_MAX_LINES} lines (tail) | pass |
| TC-9YSQ | FR-8 | truncates lines longer than ${SPINNER_MAX_LINE_LEN} chars with ellipsis | pass |
| TC-C05B | FR-8 | does not truncate lines at exactly the limit | pass |
| TC-MC3A | FR-8 | filters blank lines | pass |
| TC-HZ3F | FR-8 | trims trailing whitespace from lines | pass |
| TC-65GY | FR-8 | respects custom maxLines and maxLineLen params | pass |
| TC-V4JK | FR-8 | a large streaming document only shows the tail — prevents scrollback overflow | pass |
| TC-ZVA1 | FR-9 | output with no meta lines → one body segment | pass |
| TC-TMKW | FR-9 | empty output → no body segments | pass |
| TC-B275 | FR-9 | only meta lines → no body segments | pass |
| TC-43R0 | FR-9 | meta line splits body into two segments | pass |
| TC-HSBX | FR-9 | evidence> summary is a single meta line after the answer | pass |
| TC-U414 | FR-9 | assistant> lines are NOT meta — they are body | pass |
| TC-WWPM | FR-9 | emptyPrimaryContent is non-empty only when there is body content | pass |
| TC-CC33 | FR-9 | real-world /query output: stage lines are meta, answer prose is body | pass |
| TC-FCN7 | FR-9 | first body segment index is stable so primary-first ordering works | pass |
| TC-94OZ | FR-10 | splits a plain command into tokens | pass |
| TC-M8AN | FR-10 | handles a double-quoted argument | pass |
| TC-SZ3O | FR-10 | handles a single-quoted argument | pass |
| TC-MA7P | FR-10 | handles multiple quoted args | pass |
| TC-K7BD | FR-10 | ignores leading and trailing whitespace | pass |
| TC-N0IY | FR-10 | returns empty array for blank input | pass |
| TC-88J1 | FR-10 | handles an unclosed quote by appending the partial token | pass |
| TC-QVW0 | FR-10 | captures log output from runMainWithOutput | pass |
| TC-2RBM | FR-10 | captures error output from runMainWithOutput | pass |
| TC-HVU0 | FR-10 | captures write (streaming) output | pass |
| TC-06X3 | FR-10 | returns empty string when runMainWithOutput produces no output | pass |
| TC-0VOS | FR-10 | captures thrown errors as output text | pass |
| TC-VTOQ | FR-10 | passes args through to runMainWithOutput | pass |
| TC-U3RV | FR-11 | shows slash suggestions when input starts with slash | pass |
| TC-VG2C | FR-11 | returns the full command list for chat mode | pass |
| TC-794C | FR-11 | does not include /chat in the command list (chat is the app itself now) | pass |
| TC-FJZE | FR-11 | returns no suggestions for non-slash input | pass |
| TC-XZZV | FR-11 | sanitizes tabs from the raw input value | pass |
| TC-6X5E | FR-11 | wraps suggestion selection downward | pass |
| TC-3TQI | FR-11 | wraps suggestion selection upward | pass |
| TC-VKK0 | FR-11 | formats the chosen suggestion for explicit completion | pass |
| TC-0NWQ | FR-11 | returns empty completion text when no suggestion is selected | pass |
| TC-LXSH | FR-11 | normalizes slash commands before handing off to the CLI runner | pass |
| TC-PTRF | FR-11 | leaves normal commands unchanged | pass |
| TC-JXSQ | FR-11 | scrolls the visible suggestion window with the selected row | pass |
| TC-A1EO | FR-11 | suggests /skills when typing /sk | pass |
| TC-P7AX | FR-11 | suggests logs subcommands when typing /logs c | pass |
| TC-0FT3 | FR-11 | suggests /facts list when typing /facts li | pass |
| TC-R1K4 | FR-11 | shows /cancel only in init-flow contexts, not at idle | pass |
| TC-FV3W | FR-11 | completes multi-segment commands | pass |
| TC-LMFB | FR-11 | suppresses suggestions after complete path with trailing args | pass |
| TC-LPE9 | FR-11 | orders the command menu by catalog section, not alphabetically | pass |

### Related docs

- [TUI.md](TUI.md)

