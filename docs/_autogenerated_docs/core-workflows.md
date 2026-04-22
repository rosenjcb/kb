---
layout: default
title: Core Workflows
date: '2026-04-21'
kb_id: core-workflows
tags:
  - cli
  - workflow
  - commands
  - daily-tasks
  - core-workflows
categories:
  - reference
---

The core workflows for KB involve capturing, validating, and retrieving project knowledge using a set of CLI commands. The typical flow includes recording facts and decisions, querying prior context, and maintaining documentation close to code, versioned in Git. The most common day-to-day tasks are performed using intent commands and document browsing commands.<ul><li>**Recording Facts and Decisions**: Use `kb submit "<fact>"` to store durable markdown knowledge. Optional flags include `--domain`, `--source`, `--target`, and `--output`.</li><li>**Querying Prior Context**: Use `kb query "<topic>"` to retrieve relevant knowledge. Options include `--limit`, `--type`, `--discovery` (shallow|deep), and `--output`.</li><li>**Validating Knowledge**: Use `kb validate "<fact>"` to confirm recorded information. Optional flags include `--domain` and `--output`.</li><li>**Invalidating Knowledge**: Use `kb invalidate "<old-fact>" ["<replacement-fact>"]` to update or remove outdated facts. This command supports `--preview` and `--apply` flags.</li><li>**Explaining Changes**: Use `kb explain "<change id|fact>"` to get details about a specific change or fact. Optional flag is `--output`.</li><li>**Listing Documents**: Use `kb docs list` to view available documents. Options include `--base`, `--limit`, and `--output`.</li><li>**Viewing Documents**: Use `kb docs view <document-id>` or `kb docs view --title "<exact title>"` to inspect specific documents. Optional flag is `--base`.</li><li>**Configuring KB Base**: Use `kb use <base>` to switch the active knowledge base for the current session, or `kb use --default <base>` to set a persistent default base. `kb use --show` displays the active and default bases.</li><li>**Setting LLM Provider**: Use `kb config set llm.provider openai` to explicitly configure the LLM provider.</li></ul>
