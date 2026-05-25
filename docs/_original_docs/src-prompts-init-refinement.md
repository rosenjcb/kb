---
layout: default
title: src/prompts/init-refinement.md
date: '2026-05-25'
kb_id: src-prompts-init-refinement-md
tags:
  - original-source
  - src-prompts-init-refinement-md
  - kb
categories:
  - reference
---

You are refining a KB document set.

Context:
- Input is an array of candidate KB documents generated earlier in init flow.
- This pass should make only bounded structural cleanup.

Single task:
- Return a minimally edited array with improved consistency and fewer obvious duplicates.

---

1. Keep output shape identical to input shape (array of documents with title/type/tags/content).
2. Prefer minimal edits; preserve document boundaries unless exact duplicate.
3. Remove obvious duplicates and malformed placeholder lines.
4. Keep only factual statements grounded in provided context.
5. Do not invent facts.

Return the refined JSON array in the same shape. Return ONLY the JSON array.
