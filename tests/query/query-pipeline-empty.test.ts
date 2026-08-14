import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runQueryPipeline } from '@kb/core/service/query-pipeline.js'

/**
 * A base with no index (the default base before anyone adds a repo) must answer with a
 * clear, actionable "this base is empty" result instead of running retrieval over nothing.
 */
describe('runQueryPipeline empty base', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kb-empty-base-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('[TC-122] returns an empty-base message without touching the tool executor', async () => {
    const result = await runQueryPipeline(
      // toolExecutor/config are only used after the empty-base guard, so stubs are safe here.
      { toolExecutor: {} as never, baseDir: dir, config: {} as never },
      { query: 'how does auth work?' }
    )
    expect(result.status).toBe('uncertain')
    expect(result.evidence).toBe('none')
    expect(result.explanation).toContain('empty')
    expect(result.recommendedAction).toContain('add-repo')
  })
})
