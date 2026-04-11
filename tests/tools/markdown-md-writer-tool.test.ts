import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownMDWriterTool } from '../../src/tools/markdown-md-writer-tool'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))
  )
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-writer-'))
  tempDirs.push(dir)
  return dir
}

describe('MarkdownMDWriterTool', () => {
  it('Given a new document input, then should write markdown file and index table entry', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    const result = await writer.writeDocument({
      title: 'First Note',
      content: 'Hello world',
      tags: ['test'],
    })

    const docContents = await readFile(result.filePath, 'utf8')
    const indexContents = await readFile(path.join(baseDir, '_table.md'), 'utf8')

    expect(result.id).toBe('first-note')
    expect(docContents).toContain('# First Note')
    expect(docContents).toContain('Tags: test')
    expect(indexContents).toContain('| first-note | First Note |')
  })

  it('Given duplicate document titles without overwrite, then should create a unique suffixed file id', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    const first = await writer.writeDocument({
      title: 'Duplicate',
      content: 'First',
    })

    const second = await writer.writeDocument({
      title: 'Duplicate',
      content: 'Second',
    })

    expect(first.id).toBe('duplicate')
    expect(second.id.startsWith('duplicate-')).toBe(true)
    expect(second.id).not.toBe(first.id)
  })

  it('Given overwrite true on an existing id, then should replace the same document path', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    const first = await writer.writeDocument({
      title: 'Stable',
      content: 'v1',
      overwrite: true,
    })

    const second = await writer.writeDocument({
      title: 'Stable',
      content: 'v2',
      overwrite: true,
    })

    const final = await readFile(second.filePath, 'utf8')

    expect(first.filePath).toBe(second.filePath)
    expect(second.id).toBe('stable')
    expect(final).toContain('v2')
  })
})
