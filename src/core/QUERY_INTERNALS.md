# Query Internals: Vector Search and Crawl

## Ingestion

When a document is submitted (`kb submit`), it is split into heading-bounded chunks and stored in SQLite with two parallel indexes:

- **FTS index** (`chunks_fts`) — full-text search for lexical matching
- **Vector index** (`chunk_embeddings`) — one row per chunk with a `vector_json` column

Vectors are computed **deterministically from character codes** — no external embedding service. Each chunk's text is hashed into a unit-normalized float array via `buildDeterministicVector()` in `src/tools/sqlite-kb-index.ts`.

## Query: Hybrid Search Pipeline

`kb query` runs a multi-stage checkpoint pipeline (see `src/tools/markdown-document-reader.ts`):

1. **Hybrid retrieval** — fetches candidates using both FTS and vector similarity, then blends the scores:
   ```
   score = hybridAlpha × lexicalScore + (1 − hybridAlpha) × vectorScore
   ```
   Configured via `KB_HYBRID_QUERY_ALPHA` (default 0.5).

2. **Confidence checkpoint** — if top results fall below a threshold, advances to recovery.

3. **Lexical recovery** — broader keyword search with query token expansion.

4. **Query rewrite retry** — strips domain prefixes / simplifies tokens and retries.

Lane routing (`classifyDocumentLane`) restricts each stage to relevant document categories, narrowing the candidate set before scoring.

After retrieval, `enrichReadDocumentsAnswerWithLLM` generates a prose answer from the final evidence set.

## Crawl (init-time only)

"Crawl" refers to source-file discovery during `kb init` (`src/cli/init-cli.ts`). It is **not** involved in query time.

`crawlSourceCode()` walks the project directory with guardrails:

- Max 50 files, max 100 KB per file
- Skips dotfiles; excludes `node_modules`, `.git`, `dist`, `build`
- Extracts the first N characters of each source file (`.ts`, `.js`, `.py`, etc.)

The collected snippets are fed into the `pass1`/`pass2`/`pass-enrich` LLM synthesis passes to bootstrap initial KB documents. After `kb init` completes, crawl plays no further role.

## See Also

- `src/tools/sqlite-kb-index.ts` — chunk storage and vector generation
- `src/tools/markdown-document-reader.ts` — hybrid query pipeline
- `src/tools/retrieval-checkpoint-orchestrator.ts` — checkpoint stages
- `src/cli/init-cli.ts` — crawl and init cycle loop
- `src/core/AGENT_LOOP.md` — intent loop and retry orchestration
