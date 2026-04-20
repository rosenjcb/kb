---
layout: default
title: Deployment And Release
date: '2026-04-20'
kb_id: deployment-and-release
tags:
  - deployment
  - release
  - publishing
  - CLI
  - Jekyll
  - deployment-release
categories:
  - architecture
---

The KB project is deployed as a CLI tool and supports publishing knowledge bases to external formats like Jekyll. The primary deployment mechanism for the `kb` CLI is via `pnpm install`, followed by verification and configuration steps. For publishing, the `kb publish` command is used, with specific support for Jekyll via `kb publish-jekyll` and `src/core/publish/jekyll-sync.ts`.
