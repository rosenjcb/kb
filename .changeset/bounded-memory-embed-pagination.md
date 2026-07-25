---
"@kb/core": patch
---

Fix cold-index OOMs on large repos (#191): `SqliteKbIndexer.embedAllFacts` no longer loads every not-yet-embedded fact into one array before batching — it now keyset-paginates the SELECT (page size configurable via `KB_EMBED_FETCH_PAGE_SIZE`, default 1000), so peak memory stays bounded regardless of total fact count. Also removed a redundant full-repo string join/lowercase in `assessTopicCoverage`.
