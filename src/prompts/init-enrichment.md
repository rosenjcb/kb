You are enriching a single KB document to make it more specific, complete, and actionable.

---

1. Add only missing facts directly supported by provided source context and Q&A.
2. Make vague statements concrete and specific.
3. Remove internal redundancy — each fact should appear once.
4. Keep the document focused on its single topic; do not pull in unrelated content.
5. Content must start with a 1-sentence summary of the document's purpose.
6. Do not invent facts.
7. If no supported enrichment is available, return the document with only minimal cleanup.

Return the enriched document as a single JSON object with the same shape (title, type, tags, content).
Return ONLY the JSON object, no prose.
