import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteKbIndexer, isKbIndexEmpty } from '@kb/core/tools/sqlite-kb-index.js'

describe('isKbIndexEmpty', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kb-index-empty-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('[TC-100] returns true when the index file does not exist (never created)', () => {
    expect(isKbIndexEmpty(path.join(dir, 'missing.sqlite'))).toBe(true)
  })

  it('[TC-101] returns true for a freshly-migrated index with no units', () => {
    const dbPath = path.join(dir, '.kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.close()
    expect(isKbIndexEmpty(dbPath)).toBe(true)
  })

  it('[TC-102] returns false once the index has content', () => {
    const dbPath = path.join(dir, '.kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })
    indexer.upsertFact({ factText: 'kb indexes documents, code symbols, and facts.' })
    indexer.close()
    expect(isKbIndexEmpty(dbPath)).toBe(false)
  })
})
