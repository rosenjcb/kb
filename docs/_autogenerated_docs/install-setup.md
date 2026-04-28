---
layout: default
title: Install Setup
date: '2026-04-27'
kb_id: install-setup
tags:
  - installation
  - setup
  - cli
  - configuration
  - install-setup
categories:
  - runbook
---

This document outlines the installation and setup process for the KB project. To install KB, ensure Node 20+ is available. First, install dependencies and verify the setup by running `pnpm install`, `pnpm run check`, and `npm run refresh:global`. You can then verify the `kb` command is available using `command -v kb`. For installed clients, the supported release path is GitHub Releases, and you can install or upgrade the `kb-cli-node20.tgz` package globally with `npm install -g ./kb-cli-node20.tgz`. After installation, configure `~/.kb/config.json`. The provider is auto-detected, but can be explicitly set using `kb config set llm.provider openai`. Next, initialize your KB base by navigating to your repository and running `kb && /init --base dogfood`. To refresh an existing base after changes to README or other documentation, use `kb init --base dogfood --rescan` or `kb init --base dogfood --rescan --apply`, followed by `kb && /base use dogfood` or `kb && /init --rescan --apply`. For development, `pnpm run test`, `pnpm run type-check`, `pnpm run lint`, and `pnpm run build` are available. The pre-commit gate `npm run precommit` (lint + type-check + tests) must pass before pushing. For CLI changes, an e2e smoke test can be run by creating a temporary directory, adding a README.md, navigating into it, and running `kb init --base ci-e2e --non-interactive --debug`.
