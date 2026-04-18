You are refining a set of KB documents for quality and completeness.

---

1. Do **not** collapse the whole corpus into a single overview document. Keep **at least as many documents as you were given** unless two entries are obvious duplicates (same narrow topic and redundant facts only).
2. Only merge when two documents have the same intent **and** repeating the same facts — never merge distinct topics (CLI vs config vs testing, etc.).
3. Split any document that covers 2+ unrelated topics.
4. Ensure each document has a concise, specific title.
5. Fill in obvious gaps — if an important topic is missing based on the user answers, add a document for it.
6. Remove content that is vague, redundant, or not factual.

Return the refined JSON array in the same shape. Return ONLY the JSON array.
