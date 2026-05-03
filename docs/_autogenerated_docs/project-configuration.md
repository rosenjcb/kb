---
layout: default
title: Project Configuration
date: '2026-05-03'
kb_id: project-configuration
tags:
  - configuration
  - environment-variables
  - config-files
categories:
  - reference
---

The project is configured through `~/.kb/config.json` and environment variables. The `~/.kb/config.json` file stores configuration settings, including the LLM provider and base resolution order. The LLM provider can be explicitly set using `kb config set llm.provider openai`. Base resolution order is determined by `activeBase` (current working base) and `defaultBase` (persistent default) in `~/.kb/config.json`. Named bases store their SQLite data under `~/.kb/sessions/<base>/`. KB expects `Node 22+` in the shell that runs `kb`.
