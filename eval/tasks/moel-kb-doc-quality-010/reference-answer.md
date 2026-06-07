During `kb init`, fact categories are established through an interactive TF-IDF cosine similarity
interview (skipped when `--non-interactive` is passed). In the interactive flow, kb clusters the
indexed facts using HDBSCAN (via `scripts/fact_categories_hdbscan.py`) and proposes candidate
category names and descriptions; the user reviews and approves, edits, or rejects each proposal.
Approved categories are stored in the `fact_categories` SQLite table with their centroid vectors
and representative terms, and each fact is assigned to its best-matching category.

During `kb scan` (incremental rescan), no interview is conducted. Instead, any new or updated facts
that lack category assignments are automatically assigned to the closest existing category using
TF-IDF cosine similarity at a threshold of 0.3 — facts that do not reach this threshold remain
uncategorized. This auto-assignment is handled by `inferCategoriesForQuery()` in `SqliteKbIndexer`,
which computes cosine similarity between the new fact's TF-IDF vector and each category's centroid
vector and assigns the category whose score exceeds the threshold.

`fact_categories` (the assignment table) should not be confused with `fact_embeddings` (which stores
dense semantic vectors used for hybrid retrieval scoring). Categories are sparse TF-IDF
representations used for fact organization and browsing, while embeddings are dense vectors used
for nearest-neighbor semantic search at query time.
