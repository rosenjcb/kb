---
layout: default
title: How to start your knowledge base with kb
date: '2026-05-08'
kb_id: how-to-start-your-knowledge-base-with-kb
tags:
  - docs-generate
categories:
  - howto
---

This document outlines how to start a knowledge base using the `kb init` command.

## Goal
Create a knowledge base using `kb init`. The goal is to then use `kb query` and `kb chat` to ask questions about your project.

## Prerequisites
*   Node.js version 22
*   `kb` CLI installed

## Steps
*   Ensure Node 22 and the `kb` CLI are installed on your system.
*   Run `kb init` to build your knowledge base from scratch. You can choose between interactive or non-interactive modes:
    *   **Non-interactive**: Execute `kb init --base <disposable-base-name> --non-interactive`. A fresh, disposable base name is recommended.
    *   **Interactive**: Start the `kb` application, then type `/init --base <disposable-base-name>`.
    *   When choosing a base name, use a unique, disposable name. This name can match your evaluation run folder if you are using `eval-run.mjs`.
*   Allow `kb init` to complete all its passes through the `pass-graph`.

## Gotchas
If `kb init` is interrupted, you can resume the session using the `--continue` flag. For example, if you started with `kb init --base my-project-kb` and it stopped midway, you can restart it with `kb init --base my-project-kb --continue`.

## Verification
After initialization, verify the knowledge base by using `kb query` or `kb chat` to ask questions about your project.

## References

- - - Rebuild artifact from existing scratch: `--skip-init --run-dir ~/.kb/evaluations/<run-name>/` (expects matching clone at `~/.kb/evaluations/<run-name>/repo/`). — `fact://a93e38cddd3edfba`
- - - Flow matches CLI: each scenario runs **`docs generate --finalize`** (draft + `awaiting_review`), optional **`--reject-once "<feedback>"`** (one LLM revision; writes **`diff-introduction.txt`** / **`diff-howto.txt`** when a patch is produced), then **`docs generate --accept`** to commit the SQLite document. — `fact://fab2760880b2a40f`
- - - Each finalized doc is also written as **`export-introduction.md`** and **`export-howto.md`** (SQLite body from `docs view --output json`). — `fact://f0981894fc0a343b`
- - Optional **`--skip-purge`** to skip deleting prior eval-titled docs (ids derived from fixed `documentTitle` strings). — `fact://1a2556dcda836d63`
- - - Build the KB from scratch with the normal workflow. — `fact://d9ccb25a99b6a733`
- - - No special second-agent KB-maintenance strategy beyond answering `kb init` questions accurately. — `fact://57e72995c76c4047`
- - - Repeat on a fresh disposable base after using the intended two-agent workflow. — `fact://aa7520c7d6869fac`
- - Run: `kb init --base raylib-2026-04-27-1303 --non-interactive` (pick a fresh disposable name; `eval-run.mjs` generates this pattern automatically). — `fact://4a352590fcf9fc76`
- - Or interactively: start `kb`, then `/init --base <same>` — `fact://9495af6618012aca` — `fact://d31d60c530571394`
- - Let `kb init` complete all passes through `pass-graph`. — `fact://ca9ca33a9da09314`
- - Use a disposable base name that matches your eval run folder when using `eval-run.mjs`, or any unique name for manual runs. — `fact://968b0959b0fd5e7d`
- - - `kb query "<question>" --base ci-raylib-<date> --ou — `fact://4255a5bbf093ffd9` — `fact://3fa9278fc0996a30`
- - Repository excerpt captured during init (frozen snapshot of this file in the repo). — `fact://8a65774f5295ed46`
- - `kb` exists because maintaining a knowledge base is a pain—and most teams never do it well, or at all. — `fact://3253709867311793`
- - The goal is simple: you get a knowledge base for free, as a side effect of doing your real work. — `fact://fd72363d39364fd4`
- - If you use `kb`, you never have to "maintain" a knowledge base; it just happens. — `fact://75d94836c36b7250`
- - The goal is a base that stays useful because it's never a burden. — `fact://e15b96f9abd1ec35`
- - The only thing that matters is what your team actually does. — `fact://3eed87a352808ba8`
- - The only "process" is: keep moving forward, and let the knowledge base reflect reality as it changes. — `fact://e3433bb7df9c29a5`
- - You can always see how a decision was made, or why something changed, without digging through chat logs or old docs. — `fact://d67bcd76953a750c`
