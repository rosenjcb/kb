import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexSourceMarkdownFilesAsDocuments } from '@kb/core/core/scan-document-ingest.js'
import { retrieveHybrid } from '@kb/core/tools/hybrid-retriever.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kb-doc-index-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('indexSourceMarkdownFilesAsDocuments + hybrid retrieval', () => {
  it('[TC-186] indexes whole markdown files, links them to symbols, and retrieves via hybrid FTS', async () => {
    const indexer = new SqliteKbIndexer({ dbPath: join(tmpDir, '.kb-index.sqlite') })
    indexer.upsertCodeSymbol({
      gitRepo: 'demo',
      relPath: 'src/auth.ts',
      name: 'AuthService',
      kind: 'class',
      sourceText: 'export class AuthService { login() {} }',
    })
    indexer.close()

    const result = await indexSourceMarkdownFilesAsDocuments({
      baseDir: tmpDir,
      gitRepo: 'demo',
      matchAstNodes: true,
      files: {
        'docs/auth.md':
          '# AuthService overview\n\nAuthService handles login and session cookies for the API.\n',
      },
    })
    expect(result.filesScanned).toBe(1)
    expect(result.documentsUpserted).toBe(1)
    expect(result.linksWritten).toBeGreaterThanOrEqual(1)

    const reader = new SqliteKbIndexer({ dbPath: join(tmpDir, '.kb-index.sqlite') })
    const docs = reader.listDocumentsByRepo('demo')
    expect(docs).toHaveLength(1)
    expect(docs[0]?.title).toMatch(/AuthService/i)

    const hybrid = retrieveHybrid(reader, {
      query: 'AuthService login cookies',
      limit: 5,
      includeContent: true,
    })
    expect(hybrid.units.length).toBeGreaterThan(0)
    expect(hybrid.detail).toMatch(/hybrid:/)
    const titles = hybrid.units.map(u => u.metadata.title).join(' ')
    expect(titles.toLowerCase()).toMatch(/auth/)
    reader.close()
  })
})
