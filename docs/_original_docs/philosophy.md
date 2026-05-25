---
layout: default
title: PHILOSOPHY.md
date: '2026-05-25'
kb_id: philosophy-md
tags:
  - original-source
  - philosophy-md
  - kb
categories:
  - reference
---

# KB Philosophy

`kb` exists because maintaining a knowledge base is a pain—and most teams never do it well, or at all. The goal is simple: you get a knowledge base for free, as a side effect of doing your real work. No double entry, no extra process, no guilt about docs getting stale. If you use `kb`, you never have to "maintain" a knowledge base; it just happens.


## Guiding Principles

### Accretion, Not Overhead

`kb` bets that if you make it easy enough, knowledge will naturally accrete. Small facts, decisions, and context get captured as you work. If something is wrong or out of date, it's easy to fix or delete. No knowledge is sacred—if it's wrong, kill it. The goal is a base that stays useful because it's never a burden.


### Descriptive, Not Prescriptive

kb doesn’t tell you how to work. It just records what happened.

Your agent talks to a separate harness backed by a semantic graph built from code and markdown. No workflows, templates, or process layer on top.

The [Agile Manifesto](https://agilemanifesto.org) still says it best:

	Individuals and interactions over processes and tools  
	Working software over comprehensive documentation  
	Customer collaboration over contract negotiation  
	Responding to change over following a plan


## Change Is the Default

Everything changes. `kb` expects facts to go stale, mistakes to happen, and priorities to shift. That's normal. It's easy to update, delete, or correct anything. The only "process" is: keep moving forward, and let the knowledge base reflect reality as it changes.


## Transparency Without Effort

`kb` keeps a record of what happened, when, and why—automatically. You can always see how a decision was made, or why something changed, without digging through chat logs or old docs. If you want to go deep, the history is there. If you don't care, you never have to look.


## Fact Retrieval as a Design Variable

How facts get from the KB into a prompt is not a fixed decision — it's a configurable strategy. KB currently supports two retrieval methods, and this list is expected to grow as we learn more about what works.

**`query_expansion` (default):** The query is expanded with synonyms and graph-derived context, searched against the index, and the top results are ranked and returned. This is focused and efficient — the LLM sees the most relevant facts, not everything. It works well when the KB is large and queries are specific.

**`all_facts`:** Every fact in the KB is loaded into the prompt. No search, no ranking. The LLM sees the full knowledge base. This works well when the KB is small, when exhaustive coverage matters more than precision, or when you're debugging retrieval quality. In multi-turn loops (chat, docs generation, agent tasks), all facts are loaded **once** per session — subsequent retrievals in the same context skip the dump since the facts are already present.

The retrieval method is set via `kb config set fact_retrieval_method <method>` and applies globally across all surfaces: `kb query`, `kb chat`, docs generation, and agentic tool loops.

This is an active area of experimentation. The right retrieval strategy depends on KB size, query distribution, and LLM context window limits. Treat it as a dial, not a fixed setting.
