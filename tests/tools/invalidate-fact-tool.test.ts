import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invalidateFactTool } from '../../src/tools/invalidate-fact-tool'
import { SqliteDocumentWriter } from '../../src/tools/sqlite-document-writer'
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

async function seedDocument(
  baseDir: string,
  input: {
    title: string
    documentId: string
    content: string
    type?: 'architecture' | 'decision' | 'checklist' | 'runbook' | 'reference'
  }
): Promise<void> {
  const writer = new SqliteDocumentWriter({ baseDir })
  await writer.writeDocument({
    title: input.title,
    documentId: input.documentId,
    content: input.content,
    type: input.type,
  })
}

async function readDocumentContent(baseDir: string, id: string): Promise<string | undefined> {
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  try {
    return indexer.getDocumentContent(id)
  } finally {
    indexer.close()
  }
}

describe('invalidateFactTool', () => {
  it('replaces all matches in KB documents with replacement', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Deployment Facts',
      documentId: 'deployment-facts',
      content: 'We deploy to GCP.\nThis is a test.\nWe deploy to GCP.\n',
      type: 'reference',
    })

    const result = await invalidateFactTool(
      {
        oldFact: 'We deploy to GCP',
        replacementFact: 'We deploy to AWS',
        preview: false,
        dryRun: false,
      },
      baseDir
    )

    const updated = await readDocumentContent(baseDir, 'deployment-facts')
    expect(updated).toContain('We deploy to AWS')
    expect(updated).not.toContain('We deploy to GCP')
    expect(result.changes[0]?.documentId).toBe('deployment-facts')
    expect(result.changes[0]?.replaced).toBe(2)
  })

  it('removes all matches in KB documents if no replacement', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Deployment Facts',
      documentId: 'deployment-facts',
      content: 'We deploy to GCP.\nThis is a test.\nWe deploy to GCP.\n',
      type: 'reference',
    })

    const result = await invalidateFactTool(
      {
        oldFact: 'We deploy to GCP',
        preview: false,
        dryRun: false,
      },
      baseDir
    )

    const updated = await readDocumentContent(baseDir, 'deployment-facts')
    expect(updated).not.toContain('We deploy to GCP')
    expect(result.changes[0]?.replaced).toBe(2)
  })

  it('does not inspect or edit arbitrary repo files beside the KB store', async () => {
    const baseDir = await createTempBase()
    const unrelatedFile = path.join(baseDir, 'example.ts')
    await fs.writeFile(unrelatedFile, 'const text = "We deploy to GCP"\n', 'utf8')
    await seedDocument(baseDir, {
      title: 'Deployment Facts',
      documentId: 'deployment-facts',
      content: 'We deploy to GCP.\n',
      type: 'reference',
    })

    await invalidateFactTool(
      {
        oldFact: 'We deploy to GCP',
        replacementFact: 'We deploy to AWS',
        preview: false,
        dryRun: false,
      },
      baseDir
    )

    const unrelatedContent = await fs.readFile(unrelatedFile, 'utf8')
    expect(unrelatedContent).toContain('We deploy to GCP')
  })

  it('returns error if no matches exist in KB documents', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Deployment Facts',
      documentId: 'deployment-facts',
      content: 'We deploy to AWS.\n',
      type: 'reference',
    })

    const result = await invalidateFactTool(
      {
        oldFact: 'No such fact',
        preview: true,
        dryRun: true,
      },
      baseDir
    )

    expect(result.error).toBe('No matches found in KB documents.')
    expect(result.changes.length).toBe(0)
  })
})
