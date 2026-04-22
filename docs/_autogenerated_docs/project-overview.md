---
layout: default
title: Project Overview
date: '2026-04-21'
kb_id: project-overview
tags:
  - project
  - overview
  - purpose
  - users
  - project-overview
categories:
  - architecture
---

KB is a local-first knowledge system designed for AI workflows, providing a CLI and runtime for managing project knowledge.

*   **Purpose**: KB aims to provide a repeatable way to capture, validate, and retrieve project knowledge during development.
*   **Key Features**:
    *   Stores durable markdown knowledge.
    *   Queries knowledge through intent commands.
    *   Optionally uses SQLite hybrid retrieval (FTS + vector-style ranking) for improved search quality.
*   **Typical Workflow**:
    1.  Record facts and decisions during work.
    2.  Query prior context before making new changes.
    3.  Keep documentation close to code and version it in Git.
*   **Target Users**: Developers and teams who need to manage project knowledge effectively within their development workflows, especially those using AI agents.
*   **Integration with AI Agents**: KB is designed to integrate with AI agents by providing a "skill" format that tools expect, with a roadmap to automatically drop or sync this skill into supported agents like Cursor, Claude Code, and other common coding agents.
