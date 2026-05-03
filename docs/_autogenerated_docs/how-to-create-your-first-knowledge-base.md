---
layout: default
title: How to create your first knowledge base
date: '2026-05-03'
kb_id: how-to-create-your-first-knowledge-base
tags:
  - docs-generate
categories:
  - howto
---

This document outlines how to create your first knowledge base using `kb init`.

## Goal

Users can scan their entire repository using `kb init` and then interact with the knowledge base using `kb query` and `kb chat`.

### Prerequisites

*   `kb` installed
*   Node.js version 22 or higher

### Steps

To create a knowledge base from scratch:

1.  Build the knowledge base using the normal workflow.
2.  Run `kb init` with a unique, disposable base name. This name can match your evaluation run folder if using `eval-run.mjs`, or be any unique name for manual runs.
    *   Example: `kb init --base raylib-2026-04-27-1303 --non-interactive`
    *   Alternatively, start `kb` interactively and then use `/init --base <your-base-name>`.
3.  During initialization, a frozen snapshot of repository excerpts is captured.
4.  Allow `kb init` to complete all passes through `pass-graph`.

### Gotchas

If `kb init` is cancelled partway through, you can resume the process:

1.  Identify the base name you were using (e.g., `raylib-2026-04-27-1303`).
2.  Run the `kb init` command again, including the `--continue` flag and the original base name.
    *   Example: `kb init --base raylib-2026-04-27-1303 --continue`
    *   If you were running interactively, start `kb` and then use `/init --base <your-base-name> --continue`.

### Verification

The knowledge base is successfully created when you can start `kb`, then `/chat`, and begin asking questions about your project.

## References

- You can always see how a decision was made, or why something changed, without digging through chat logs or old docs. — `fact://a09affa4a6baa2f6`
- The only "process" is: keep moving forward, and let the knowledge base reflect reality as it changes. — `fact://a0c438014530557a`
- The only thing that matters is what your team actually does. — `fact://88b20055efb93b3b`
- The goal is a base that stays useful because it's never a burden. — `fact://da70e8b07d72a53d`
- If you use `kb`, you never have to "maintain" a knowledge base; it just happens. — `fact://4afd73ae6c4624c8`
- The goal is simple: you get a knowledge base for free, as a side effect of doing your real work. — `fact://2871cdd9031051ec`
- `kb` exists because maintaining a knowledge base is a pain—and most teams never do it well, or at all. — `fact://e429ebb95c83391d`
- Repository excerpt captured during init (frozen snapshot of this file in the repo). — `fact://387b3b3127215609`
- - `kb query "<question>" --base ci-raylib-<date> --ou — `fact://4255a5bbf093ffd9`
- Use a disposable base name that matches your eval run folder when using `eval-run.mjs`, or any unique name for manual runs. — `fact://5a3c808bff5b3f4b`
- Let `kb init` complete all passes through `pass-graph`. — `fact://9a705e76ee7871d7`
- Or interactively: start `kb`, then `/init --base <same>` — `fact://9495af6618012aca`
- Run: `kb init --base raylib-2026-04-27-1303 --non-interactive` (pick a fresh disposable name; `eval-run.mjs` generates this pattern automatically). — `fact://baf61d6b6d98aad3`
- - Repeat on a fresh disposable base after using the intended two-agent workflow. — `fact://eb0395a9f70fa1ac`
- - No special second-agent KB-maintenance strategy beyond answering `kb init` questions accurately. — `fact://36054320f0f5c2e3`
- - Build the KB from scratch with the normal workflow. — `fact://619cd33d8fc41cb2`
- Optional **`--skip-purge`** to skip deleting prior eval-titled docs (ids derived from fixed `documentTitle` strings). — `fact://405e65e682477fd6`
- - Each finalized doc is also written as **`export-introduction.md`** and **`export-howto.md`** (SQLite body from `docs view --output json`). — `fact://6de8108ddef548d2`
- - Flow matches CLI: each scenario runs **`docs generate --finalize`** (draft + `awaiting_review`), optional **`--reject-once "<feedback>"`** (one LLM revision; writes **`diff-introduction.txt`** / **`diff-howto.txt`** when a patch is produced), then **`docs generate --accept`** to commit the SQLite document. — `fact://98820ecf8f28f36f`
- - Rebuild artifact from existing scratch: `--skip-init --run-dir ~/.kb/evaluations/<run-name>/` (expects matching clone at `~/.kb/evaluations/<run-name>/repo/`). — `fact://646aa8632002daa9`
