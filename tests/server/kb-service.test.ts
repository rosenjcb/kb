import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KbConfig } from '../../src/cli/kb-config'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'
import { createKbService } from '../../src/server/kb-service'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeBaseWithFacts(): Promise<string> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-service-'))
  tempDirs.push(baseDir)
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  indexer.upsertFact({
    factText: 'The authentication module validates JWT tokens during login.',
    sourceKind: 'import_doc',
    sourceRef: 'docs/auth.md#s1',
  })
  indexer.upsertFact({
    factText: 'Rate limiting is enforced by a token-bucket middleware.',
    sourceKind: 'import_doc',
    sourceRef: 'docs/limits.md#s1',
  })
  return baseDir
}

describe('createKbService', () => {
  it('readFacts returns matching facts from the on-disk index', async () => {
    const baseDir = await makeBaseWithFacts()
    const service = createKbService({ baseDir, config: {} as KbConfig })

    const response = (await service.readFacts({
      query: 'authentication',
      mode: 'content',
      includeContent: true,
    })) as { results: Array<{ content?: string }> }

    expect(response.results.length).toBeGreaterThan(0)
    const joined = response.results.map(r => r.content ?? '').join('\n')
    expect(joined.toLowerCase()).toContain('authentication')
    await service.close()
  })

  it('health reports the base name and a present index mtime', async () => {
    const baseDir = await makeBaseWithFacts()
    const service = createKbService({ baseDir, config: {} as KbConfig })

    const health = service.health()
    expect(health.ok).toBe(true)
    expect(health.base).toBe(path.basename(baseDir))
    expect(health.indexMtime).toBeTruthy()
    await service.close()
  })

  it('serializes concurrent reindex calls via the in-process guard', async () => {
    const baseDir = await makeBaseWithFacts()
    const service = createKbService({ baseDir, config: {} as KbConfig })

    // No repos tracked → runScanCommand throws; the guard must still reset so a
    // second call is not blocked by a stale "in progress" flag.
    await expect(service.reindex()).rejects.toThrow()
    expect(service.isReindexing()).toBe(false)
    await service.close()
  })

  it('health reports indexing while background bootstrap is still running', async () => {
    const baseDir = await makeBaseWithFacts()
    const bootstrapState = {
      indexing: true,
      progressLine: '[init] @ catalog-service │ [========----------------] 2/6 document-facts 18/42 docs',
      settled: Promise.resolve(),
    }
    const service = createKbService({
      baseDir,
      config: {} as KbConfig,
      bootstrapState,
    })

    const health = service.health()
    expect(health.ok).toBe(true)
    expect(health.indexing).toBe(true)
    expect(health.bootstrapProgress).toContain('catalog-service')
    await service.close()
  })
})
