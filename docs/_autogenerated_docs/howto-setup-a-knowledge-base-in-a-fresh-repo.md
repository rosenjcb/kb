---
layout: default
title: Howto setup a knowledge base in a fresh repo
date: '2026-05-24'
kb_id: howto-setup-a-knowledge-base-in-a-fresh-repo
tags:
  - docs-generate
categories:
  - howto
---

This guide explains how to set up a knowledge base for your codebase using the `kb` command-line tool. The `kb` tool allows you to bootstrap a knowledge base from your repository, scanning and indexing your code and documents to create a queryable and lightweight knowledge base [fact-f0c7dd2c08ba7803] [fact-cddc7e6aa33210d4].

## Installation

Specific installation steps for the `kb cli` are _(not provided)_.

The `kb` command-line tool is used to interact with the knowledge base. For example, to initialize a knowledge base named `your-awesome-project` in your repository:

```bash
cd ~/{{YOUR_AWESOME_REPO}}
kb init --base your-awesome-project
```

## Init lifecycle

The `kb init` command bootstraps a knowledge base from a repository [fact-f0c7dd2c08ba7803]. It scans and indexes code and documents to create a queryable and lightweight knowledge base [fact-cddc7e6aa33210d4]. This process produces LLM-synthesized documents that are stored within the knowledge base [fact-cd95d472886d0eab]. The goal is to produce a usable knowledge base from the current repository without requiring manual intervention [fact-b0a9d1aeaa802896].

Key components involved in the `init` lifecycle include:

*   `readCodeFactsManifest` [fact-a7788508994a2f7e]
*   `writeCodeFactsManifest` [fact-3c60f7c4259c01b7]
*   `manifestPath` [fact-ec206e52d42fad7b]
*   `diffChangedFiles` [fact-cbf19b75ddb70c4e]
*   `hashFileContents` [fact-86b88243bef03e01]
*   The `CodeFactsManifest` interface [fact-062de7d86eda960a]
*   The `CODE_FACTS_MANIFEST_FILENAME` variable [fact-3d2074dc2a795281]
*   The `SOURCE_CODE_EXCLUDE_DIRS` variable [fact-475023d742e7bd03]
*   The `InitInterviewRound` interface [fact-4405edbf308728b1]
*   The `InitCheckpoint` interface [fact-f7ca28e04e2c2783]

## Querying Your Knowledge Base

Use the `kb query` command to interact with your knowledge base. For an already-populated knowledge base session, the `query` command requires the `--base` argument [fact-756ddd4c644a9752].

The knowledge base provides a graph that offers a structural view of how ideas connect, which a flat SQLite full-text index cannot express [fact-61b9c2f43ef389bf].

Details on a specific `kb chat` interface are _(not provided)_.

## (Re)scanning

The `kb init` command performs the initial scan and indexing of code and documents [fact-cddc7e6aa33210d4].

While a dedicated `kb scan` command for rescanning is _(not provided)_ in the facts, you can manage and update facts within your knowledge base using the `kb submit` and `kb invalidate` commands [fact-c69c0ce49c138848]. These operations are designed for knowledge base cleanup, not for codebase refactoring [fact-536e0c6379891a50].

Examples of fact management commands:

```bash
kb submit "<fact>" [--base <name>] [--domain ops] [--source runbook] [--include-session-logs] [--output human|json]
kb invalidate "<old-fact>" ["<replacement-fact>"] [--base <name>] [--apply] [--output human|json]
```

## References

- `kb init` bootstraps a knowledge base from a repo. — `fact://f0c7dd2c08ba7803`
- - `query` — Fresh clone → same capture minus init; requires `--base` for an already-populated KB session. — `fact://756ddd4c644a9752`
- readCodeFactsManifest is a Function exported from src/cli/init-code-facts-manifest.ts — `fact://a7788508994a2f7e`
- manifestPath is a Function exported from src/cli/init-code-facts-manifest.ts — `fact://ec206e52d42fad7b`
- `kb publish jekyll --base dogfood --dir docs/ --apply` (run from the repo root) syncs the dogfood knowledge base into this directory: — `fact://926946a57046ff16`
- cd ~/{{YOUR_AWESOME_REPO}} kb && /init --base dogfood — `fact://08a2a038c9350398`
- Scan and index code and documents once, and you get a queryable and lightweight knowledge base. — `fact://cddc7e6aa33210d4`
- - CLI wording should make this explicit: these are knowledge-base cleanup operations, not codebase refactors. — `fact://536e0c6379891a50`
- LLM-synthesized documents produced by `kb init` and stored in the knowledge base. — `fact://cd95d472886d0eab`
- SOURCE_CODE_EXCLUDE_DIRS is a Variable exported from src/cli/init-cli.ts — `fact://475023d742e7bd03`
- CodeFactsManifest is a Interface exported from src/cli/init-code-facts-manifest.ts — `fact://062de7d86eda960a`
- Does `kb init` produce a usable knowledge base from the current repo without manual surgery? — `fact://b0a9d1aeaa802896`
- As you build up your knowledge base, the graph gives you a structural view of how ideas connect — something the flat SQLite full-text index cannot express. — `fact://61b9c2f43ef389bf`
- writeCodeFactsManifest is a Function exported from src/cli/init-code-facts-manifest.ts — `fact://3c60f7c4259c01b7`
- kb submit "<fact>" [--base <name>] [--domain ops] [--source runbook] [--include-session-logs] [--output human|json] kb invalidate "<old-fact>" ["<replacement-fact>"] [--base <name>] [--apply] [--output human|json] — `fact://c69c0ce49c138848`
- diffChangedFiles is a Function exported from src/cli/init-code-facts-manifest.ts — `fact://cbf19b75ddb70c4e`
- InitInterviewRound is a Interface exported from src/cli/init-cli.ts — `fact://4405edbf308728b1`
- InitCheckpoint is a Interface exported from src/cli/init-cli.ts — `fact://f7ca28e04e2c2783`
- CODE_FACTS_MANIFEST_FILENAME is a Variable exported from src/cli/init-code-facts-manifest.ts — `fact://3d2074dc2a795281`
- hashFileContents is a Function exported from src/cli/init-code-facts-manifest.ts — `fact://86b88243bef03e01`
