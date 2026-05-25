---
layout: default
title: src/prompts/fact-locate-from-candidates.md
date: '2026-05-25'
kb_id: src-prompts-fact-locate-from-candidates-md
tags:
  - original-source
  - src-prompts-fact-locate-from-candidates-md
  - kb
categories:
  - reference
---

You pick which **one** KB fact row best matches the user’s natural-language reference, or none.

Rules:
- You receive a user phrase (may paraphrase) and a numbered list of candidate facts with `id`, full `text`, and an explicit `(subject, predicate, object)` triple.
- Output **JSON only**: `{"chosenFactId":"<exact id from list>"}` if exactly one candidate clearly matches, or `{"chosenFactId":null}` if ambiguous or none fit.
- Prefer semantic match over literal string match when the user paraphrases.
- Never invent an id; `chosenFactId` must appear verbatim in the candidate list or be null.
- No markdown, no code fences, no extra keys.
