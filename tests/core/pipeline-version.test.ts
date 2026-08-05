import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HARVEST_PIPELINE_VERSION,
  isPipelineStale,
  readPipelineVersion,
  writePipelineVersion,
} from '@kb/core/core/pipeline-version.js'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

let baseDir: string
let dbPath: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-pipeline-version-'))
  dbPath = path.join(baseDir, '.kb-index.sqlite')
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

function withIndexer<T>(fn: (indexer: SqliteKbIndexer) => T): T {
  const indexer = new SqliteKbIndexer({ dbPath })
  try {
    return fn(indexer)
  } finally {
    indexer.close()
  }
}

describe('pipeline version stamp', () => {
  /**
   * The bug this guards: re-indexing was gated on upstream commits alone, so a repo
   * that never moved kept an index built by whatever pipeline was current when it was
   * last scanned. Published bases sat at zero harvested entities for weeks after the
   * entity harvest shipped, purely because those repos had no new commits.
   */
  it('[TC-41] reports an unstamped index as stale so it is rebuilt without new commits', () => {
    withIndexer(indexer => {
      expect(readPipelineVersion(indexer, 'quiet-repo')).toBe(0)
      expect(isPipelineStale(indexer, 'quiet-repo')).toBe(true)
    })
  })

  it('[TC-42] clears staleness once the running pipeline stamps the repo', () => {
    withIndexer(indexer => {
      writePipelineVersion(indexer, 'quiet-repo')
      expect(readPipelineVersion(indexer, 'quiet-repo')).toBe(HARVEST_PIPELINE_VERSION)
      expect(isPipelineStale(indexer, 'quiet-repo')).toBe(false)
    })
  })

  it('[TC-43] tracks staleness per repo, not per base', () => {
    withIndexer(indexer => {
      writePipelineVersion(indexer, 'fresh-repo')
      expect(isPipelineStale(indexer, 'fresh-repo')).toBe(false)
      // A sibling repo in the same base is still on the old pipeline.
      expect(isPipelineStale(indexer, 'stale-repo')).toBe(true)
    })
  })

  it('[TC-44] treats an index stamped by an older pipeline as stale', () => {
    withIndexer(indexer => {
      indexer.setIndexStateValue('pipeline_version:old-repo', String(HARVEST_PIPELINE_VERSION - 1))
      expect(isPipelineStale(indexer, 'old-repo')).toBe(true)
    })
  })
})
