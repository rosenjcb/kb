---
layout: default
title: Testing Workflow
date: '2026-04-21'
kb_id: testing-workflow
tags:
  - testing
  - development
categories:
  - runbook
---

To run tests in the KB project, use the `pnpm run test` command. The project includes a comprehensive suite of tests covering various components, including CLI commands, core functionalities, and tools. These tests are crucial for validating the system's behavior and ensuring the quality of new changes.<ul><li>**Running Tests:** Execute `pnpm run test` from the project root.</li><li>**Test File Locations:** Test files are located in the `tests/` directory, mirroring the structure of the `src/` directory. For example, `tests/cli/base-selection.test.ts` tests `src/cli/base-selection.ts`.</li><li>**Key Test Flows:**<ul><li>**CLI Commands:** Tests for all CLI commands (e.g., `kb use`, `kb submit`, `kb query`) are found under `tests/cli/`.</li><li>**Core Functionality:** Core components like `agent-loop`, `llm-provider`, and `stream-manager` have dedicated tests in `tests/core/`.</li><li>**Tools and Orchestrators:** The various tools and orchestrators (e.g., `document-writer`, `explain-orchestrator`, `submit-orchestrator`) are tested under `tests/tools/`.</li><li>**UI Components:** Tests for the Text User Interface (TUI) components are in `tests/tui/`.</li><li>**Evaluation Snapshots:** `tests/eval-snapshot.test.ts` and `tests/eval-task-artifact.test.ts` indicate testing related to evaluation and task artifacts.</li></ul></li></ul>
