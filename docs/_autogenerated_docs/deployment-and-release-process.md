---
layout: default
title: Deployment and Release Process
date: '2026-05-03'
kb_id: deployment-and-release-process
tags:
  - deployment
  - release
  - publishing
  - installation
  - deployment-release
categories:
  - reference
---

The project is deployed, released, or published primarily through GitHub Releases. For installed clients, the supported release path is GitHub Releases. CI builds a fresh `kb-cli-node22.tgz` package for every push to `main`. Users can install or upgrade the CLI with `npm install -g ./kb-cli-node22.tgz`. The `kb sync` command can be used to update from `github.com/rosenjcb/kb` and relink globally, or to rebuild/relink the managed clone without fetching using `kb sync --no-pull`. The `src/cli/publish-cli.ts` and `src/cli/publish-jekyll.ts` files, along with `src/core/publish/jekyll-sync.ts`, indicate functionality related to publishing, potentially to Jekyll.
