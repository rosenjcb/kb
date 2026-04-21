---
layout: default
title: Project Configuration
date: '2026-04-20'
kb_id: project-configuration
tags:
  - configuration
  - cli
  - llm
  - base
categories:
  - reference
---

The KB project is configured primarily through a `config.json` file located in the user's home directory at `~/.kb/config.json`, and through CLI commands.

*   **Configuration File**: The main configuration file is `~/.kb/config.json`.
*   **LLM Provider**: The LLM provider is auto-detected based on available keys. It can be explicitly set using the CLI command: `kb config set llm.provider openai`.
*   **Knowledge Base (KB) Base**: The project uses named knowledge bases, which store their SQLite data under `~/.kb/sessions/<base>/`.
    *   **Active Base**: The current working base for a session is set using `kb use <base>`. This is stored as `activeBase` in `~/.kb/config.json`.
    *   **Persistent Default Base**: A persistent default base can be saved using `kb use --default <base>` (or `kb default <base>`). This is stored as `defaultBase` in `~/.kb/config.json`.
    *   **Resolution Order**: The active base takes precedence over the persistent default base.
*   **Prerequisites Validation**: The system validates prerequisites separately. If no base is configured, a "knowledge base" error occurs. If no LLM credentials or provider are available, an "LLM" error occurs. These errors are not combined and are handled in `src/cli/cli-prerequisites.ts`.
