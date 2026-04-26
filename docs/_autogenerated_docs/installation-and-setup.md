---
layout: default
title: Installation And Setup
date: '2026-04-21'
kb_id: installation-and-setup
tags:
  - installation
  - setup
  - cli
  - configuration
  - install-setup
categories:
  - runbook
---

To install and set up KB, you need to install the project dependencies, configure your LLM provider, and set your knowledge base. First, install the project dependencies using `pnpm install` and verify the installation with `pnpm run check` and `npm run refresh:global`. Next, configure your LLM provider by setting it explicitly in `~/.kb/config.json` using the command `kb config set llm.provider openai`. Finally, set your KB base using `kb use <base>` to switch the active base for a session, or `kb use --default <base>` to save a persistent default. You can view the active base and configured default with `kb use --show`. Named bases store their SQLite data under `~/.kb/sessions/<base>/`.
