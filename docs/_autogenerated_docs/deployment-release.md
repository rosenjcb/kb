---
layout: default
title: Deployment Release
date: '2026-04-27'
kb_id: deployment-release
tags:
  - deployment
  - release
  - publishing
  - deployment-release
categories:
  - reference
---

The KB project is deployed and released primarily through GitHub Releases, with CI building a fresh `kb-cli-node22.tgz` package for every push to `main`. Users can install or upgrade the CLI globally using `npm install -g ./kb-cli-node22.tgz`. The project also supports a `kb sync` command to rebuild and relink a managed clone without fetching, and `kb publish-jekyll` for publishing to Jekyll. For development, `pnpm run build` compiles the project. The `npm run refresh:global` command ensures the global `kb` installation is up-to-date.
