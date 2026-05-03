---
layout: default
title: Install and Setup
date: '2026-05-03'
kb_id: install-and-setup
tags:
  - installation
  - setup
  - cli
  - configuration
  - install-setup
categories:
  - howto
---

To install and set up the KB project, you first install the package, then configure it, and finally initialize your knowledge base. KB expects Node 22+ to be installed. To install and verify, run `pnpm install`, `pnpm run check`, `npm run refresh:global`, and `command -v kb`. For installed clients, the supported release path is GitHub Releases, and you can install or upgrade with `npm install -g ./kb-cli-node22.tgz`. After installation, configure `~/.kb/config.json`. The provider is auto-detected, but you can set it explicitly using `kb config set llm.provider openai`. Finally, initialize your KB base by navigating to your repository and running `kb && /init --base dogfood`. To refresh an existing base after README or docs changes, use `kb init --base dogfood --rescan` or `kb init --base dogfood --rescan --apply`, followed by `kb && /base use dogfood` and `kb && /init --rescan --apply`. Named bases store their SQLite data under `~/.kb/sessions/<base>/`.
