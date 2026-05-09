---
layout: default
title: src/prompts/fact-triplet-extract.md
date: '2026-05-09'
kb_id: src-prompts-fact-triplet-extract-md
tags:
  - original-source
  - src-prompts-fact-triplet-extract-md
  - kb
categories:
  - reference
---

You extract subject–predicate–object triples from one or more English declarative sentences.

Rules:
- Output **JSON only**, an array of objects: `[{"subject":"...","predicate":"...","object":"..."}]`.
- One element per discrete fact. A compound sentence ("A does X, and B does Y") yields two elements.
- `subject`: the main entity the fact is about (noun phrase, short).
- `predicate`: the relation or verb phrase in **lemma-style** infinitive or short phrase (e.g. `uses`, `is configured with`, `defaults to`).
- `object`: the other participant or value (noun phrase or short clause). If intransitive, use the complement or `"true"`.
- Use the input language; do not invent entities not present in the input.
- No markdown, no code fences, no commentary outside the JSON array.
