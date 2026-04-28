---
layout: default
title: Project Configuration
date: '2026-04-27'
kb_id: project-configuration
tags:
  - configuration
  - environment-variables
  - config-files
categories:
  - reference
---

The KB project is configured through a combination of environment variables and configuration files, primarily `~/.kb/config.json`. Node.js version 20+ is expected for running KB. The `kb config set` command is used to explicitly set configuration values, such as the LLM provider. Named knowledge bases store their SQLite data under `~/.kb/sessions/<base>/`. Base resolution order for `kb` is `activeBase` then `defaultBase`, both of which are stored in `~/.kb/config.json`.
