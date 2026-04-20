---
layout: default
title: High-Level Architecture
date: '2026-04-20'
kb_id: high-level-architecture
tags:
  - architecture
  - components
  - cli
  - runtime
  - knowledge base
  - sqlite
categories:
  - architecture
---

KB is a local-first knowledge system for AI workflows, providing a CLI and runtime to store, query, and validate project knowledge. The system is divided into three main components: `src/core`, `src/cli`, and `src/tools`.

*   **`src/core`**: This component handles the fundamental abstractions, including the provider abstraction, intent loop, agent loop, and runtime types. It manages the core logic for how KB interacts with LLMs and processes knowledge.
*   **`src/cli`**: This component serves as the command-line interface entrypoint. It is responsible for parsing intent commands, managing base selection (e.g., `kb use`), and handling the initialization of the knowledge base. Key files include `src/cli/index.ts` for the main entrypoint, `src/cli/base-selection.ts` for base management, and `src/cli/intent-cli.ts` for intent command processing.
*   **`src/tools`**: This component contains the write and query tools, integrating markdown and SQLite indexing. It includes functionalities like `document-writer.ts` for storing knowledge, `sqlite-kb-index.ts` for managing the SQLite database, and various orchestrators (e.g., `submit-orchestrator.ts`, `query-research-orchestrator.ts`) for complex operations. SQLite is optionally used for hybrid retrieval (FTS + vector-style ranking) to improve search quality as the knowledge corpus grows.

Named bases store their SQLite data under `~/.kb/sessions/<base>/`, and configuration lives in `~/.kb/config.json`.
