import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invalidateFactTool } from '../../src/tools/invalidate-fact-tool'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function createTempBase(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-invalidate-'))
  tempDirs.push(dir)
  return dir
}

async function seedFact(baseDir: string, factText: string): Promise<void> {
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  indexer.upsertFact({ factText, sourceKind: 'submit', sourceRef: 'test' })
  indexer.close()
}

async function listFactTexts(baseDir: string): Promise<string[]> {
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  try {
    return indexer.listFactsForQuery(20).map(row => row.fact_text)
  } finally {
    indexer.close()
  }
}

describe('invalidateFactTool', () => {
  it('replaces a canonical fact with replacement', async () => {
    const baseDir = await createTempBase()
    await seedFact(baseDir, 'We deploy to GCP')

    const result = await invalidateFactTool(
      {
        oldFact: 'We deploy to GCP',
        replacementFact: 'We deploy to AWS',
        preview: false,
      },
      baseDir
    )

    const updated = await listFactTexts(baseDir)
    expect(updated).toContain('We deploy to AWS')
    expect(updated).not.toContain('We deploy to GCP')
    expect(result.changes[0]?.factId).toBeDefined()
  })

  it('removes a canonical fact if no replacement', async () => {
    const baseDir = await createTempBase()
    await seedFact(baseDir, 'We deploy to GCP')

    const _result = await invalidateFactTool(
      {
        oldFact: 'We deploy to GCP',
        preview: false,
      },
      baseDir
    )

    const updated = await listFactTexts(baseDir)
    expect(updated).not.toContain('We deploy to GCP')
  })

  it('does not inspect or edit arbitrary repo files beside the KB store', async () => {
    const baseDir = await createTempBase()
    const unrelatedFile = path.join(baseDir, 'example.ts')
    await fs.writeFile(unrelatedFile, 'const text = "We deploy to GCP"\n', 'utf8')
    await seedFact(baseDir, 'We deploy to GCP')

    await invalidateFactTool(
      {
        oldFact: 'We deploy to GCP',
        replacementFact: 'We deploy to AWS',
        preview: false,
      },
      baseDir
    )

    const unrelatedContent = await fs.readFile(unrelatedFile, 'utf8')
    expect(unrelatedContent).toContain('We deploy to GCP')
  })

  it('matches stored fact when oldFact has extra whitespace (same normalization as upsert)', async () => {
    const baseDir = await createTempBase()
    await seedFact(baseDir, 'We deploy to GCP')

    const result = await invalidateFactTool(
      {
        oldFact: 'We   deploy   to   GCP',
        replacementFact: 'We deploy to AWS',
        preview: false,
      },
      baseDir
    )

    const updated = await listFactTexts(baseDir)
    expect(updated).toContain('We deploy to AWS')
    expect(result.error).toBeUndefined()
    expect(result.changes).toHaveLength(1)
  })

  it('returns error if no matches exist in KB documents', async () => {
    const baseDir = await createTempBase()
    await seedFact(baseDir, 'We deploy to AWS')

    const result = await invalidateFactTool(
      {
        oldFact: 'No such fact',
        preview: true,
      },
      baseDir
    )

    expect(result.error).toBe('No matches found in canonical facts.')
    expect(result.changes.length).toBe(0)
  })
})
