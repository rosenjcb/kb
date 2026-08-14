/**
 * One-shot: fill doc/code/fact embeddings for a session base with Gemini.
 * Usage: KB_EMBEDDER=gemini GEMINI_API_KEY=… pnpm exec tsx scripts/embed-base-gemini.ts [base]
 */
import path from 'node:path'
import os from 'node:os'
import { createEmbedder } from '@kb/core/core/embeddings.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

async function main() {
  process.env.KB_EMBEDDER = process.env.KB_EMBEDDER?.trim() || 'gemini'
  const base = process.argv[2]?.trim() || 'eval-kb'
  const dbPath = path.join(os.homedir(), '.kb', 'sessions', base, '.kb-index.sqlite')

  const embedder = createEmbedder()
  if (!embedder) {
    console.error('createEmbedder() is undefined — need GEMINI_API_KEY and KB_EMBEDDER=gemini')
    process.exit(1)
  }

  console.log(`[embed] base=${base}`)
  console.log(`[embed] backend=${embedder.modelId} dims=${embedder.dimensions}`)
  console.log(`[embed] db=${dbPath}`)

  const indexer = new SqliteKbIndexer({ dbPath, embedder })
  const t0 = Date.now()
  let lastLog = 0
  const progress = (label: string) => (done: number, total: number) => {
    const now = Date.now()
    if (done === total || now - lastLog > 2000) {
      lastLog = now
      console.log(`[embed] ${label} ${done}/${total}`)
    }
  }

  try {
    const documents = await indexer.embedAllDocuments(progress('documents'))
    const symbols = await indexer.embedAllCodeSymbols(progress('symbols'))
    const facts = await indexer.embedAllFacts(progress('facts'))
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          base,
          documents,
          symbols,
          facts,
          elapsed_ms: Date.now() - t0,
          modelId: embedder.modelId,
        },
        null,
        2
      )
    )
  } finally {
    indexer.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
