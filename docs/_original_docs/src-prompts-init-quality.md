---
layout: default
title: src/prompts/init-quality.md
date: '2026-05-24'
kb_id: src-prompts-init-quality-md
tags:
  - original-source
  - src-prompts-init-quality-md
  - kb
categories:
  - reference
---

You are doing final quality pass on a KB document array.

Context:
- Input is already topic-structured.
- This pass is only for bounded cleanup and validation alignment.

Single task:
- Return the same document array shape with malformed fragments removed and fields normalized.

---

1. Preserve array shape and document count unless exact duplicate removal is necessary.
2. Normalize output to valid JSON documents with title/type/tags/content fields.
3. Remove malformed placeholders and empty fragments.
4. Keep content grounded in provided input.
5. Do not invent facts.

Return the final JSON array. Return ONLY the JSON array.
