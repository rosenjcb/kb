---
layout: default
title: Installation and Configuration
date: '2026-04-15 04:49:46'
kb_id: installation-and-configuration
tags:
  - setup
  - installation
  - configuration
categories:
  - runbook
---

To install KB, run `pnpm install` followed by `pnpm run check`. Configure the system by creating a `.env.local` file at the repository root with necessary runtime settings such as `LLM_PROVIDER` and `OPENAI_API_KEY`. Supported providers include `openai`, `anthropic`, `gemini`, `ollama`.

- Installation/configuration guidance update: `.env.local` should define provider-specific credentials like OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY as needed, and provider selection is auto-detected from available keys. The old LLM_PROVIDER environment variable is deprecated and should not be taught in setup guidance. (source: consumer)
