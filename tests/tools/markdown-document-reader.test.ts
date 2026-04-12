import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownDocumentReader } from '../../src/tools/markdown-document-reader'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-reader-'))
  tempDirs.push(dir)
  return dir
}

describe('MarkdownDocumentReader', () => {
  it('Given type filter, then should only return matching document types', async () => {
    const baseDir = await createTempDir()
    await mkdir(baseDir, { recursive: true })

    await writeFile(
      path.join(baseDir, 'arch.md'),
      '# Architecture Doc\n\nCreated: 2026-01-01T00:00:00.000Z\nType: architecture\nTags: system\n\nBody\n',
      'utf8'
    )

    await writeFile(
      path.join(baseDir, 'runbook.md'),
      '# Runbook Doc\n\nCreated: 2026-01-01T00:00:00.000Z\nType: runbook\nTags: ops\n\nBody\n',
      'utf8'
    )

    const reader = new MarkdownDocumentReader(baseDir)
    const response = await reader.queryDocuments({ type: 'architecture' })

    expect(response.total).toBe(1)
    expect(response.results[0]?.metadata.id).toBe('arch')
    expect(response.results[0]?.metadata.type).toBe('architecture')
  })

  it('Given query + type filter, then should apply both constraints', async () => {
    const baseDir = await createTempDir()

    await writeFile(
      path.join(baseDir, 'decision-1.md'),
      '# Auth Decision\n\nCreated: 2026-01-01T00:00:00.000Z\nType: decision\n\nBody\n',
      'utf8'
    )

    await writeFile(
      path.join(baseDir, 'reference-1.md'),
      '# Auth Reference\n\nCreated: 2026-01-01T00:00:00.000Z\nType: reference\n\nBody\n',
      'utf8'
    )

    const reader = new MarkdownDocumentReader(baseDir)
    const response = await reader.queryDocuments({
      query: 'auth',
      mode: 'title',
      type: 'decision',
    })

    expect(response.total).toBe(1)
    expect(response.results[0]?.metadata.id).toBe('decision-1')
  })

    it('Given natural-language question, when querying content mode, then matches by token overlap', async () => {
      const baseDir = await createTempDir()
      await writeFile(path.join(baseDir, 'future-plan.md'), `# Storage Direction\n\nCreated: 2026-01-01\nType: reference\n\nThe current persistent store is markdown files. SQLite is a potential future backend direction.\n`)

      const reader = new MarkdownDocumentReader(baseDir)
      const response = await reader.queryDocuments({
        query: 'What is the future plan for our document store?',
        mode: 'content',
        includeContent: true,
      })

      expect(response.total).toBe(1)
      expect(response.results[0]?.metadata.id).toBe('future-plan')
    })
})
