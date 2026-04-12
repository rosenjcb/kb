import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownMDWriterTool } from '../../src/tools/markdown-md-writer-tool'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-specialized-'))
  tempDirs.push(dir)
  return dir
}

describe('MarkdownMDWriterTool specialized operations', () => {
  it('Given append_to_document, then should append content at bottom by default', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    await writer.writeDocument({
      title: 'Decision Log',
      content: 'Initial entry',
      documentId: 'decision-log',
      overwrite: true,
    })

    const result = await writer.appendToDocument({
      documentId: 'decision-log',
      content: 'Second entry',
    })

    const final = await readFile(result.filePath, 'utf8')
    expect(final).toContain('Initial entry')
    expect(final).toContain('Second entry')
    expect(final.indexOf('Initial entry')).toBeLessThan(final.indexOf('Second entry'))
  })

  it('Given append_to_document with top position, then should prepend content', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    await writer.writeDocument({
      title: 'Notes',
      content: 'Existing body',
      documentId: 'notes',
      overwrite: true,
    })

    const result = await writer.appendToDocument({
      documentId: 'notes',
      content: 'Prepended header text',
      position: 'top',
    })

    const final = await readFile(result.filePath, 'utf8')
    expect(final.indexOf('Prepended header text')).toBeLessThan(final.indexOf('# Notes'))
  })

  it('Given update_document, then should replace content and preserve created timestamp', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    const first = await writer.writeDocument({
      title: 'Runbook',
      content: 'Version 1',
      documentId: 'runbook',
      overwrite: true,
    })

    const updated = await writer.updateDocument({
      documentId: 'runbook',
      content: 'Version 2',
      title: 'Runbook Updated',
    })

    const final = await readFile(updated.filePath, 'utf8')
    expect(final).toContain('# Runbook Updated')
    expect(final).toContain('Version 2')
    expect(final).not.toContain('Version 1')
    expect(updated.createdAt).toBe(first.createdAt)
  })

  it('Given prune_document, then should remove matching section and keep others', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    await writer.writeDocument({
      title: 'Deploy Runbook',
      content: [
        '### Overview',
        'Keep this section',
        '',
        '### Deprecated Commands',
        'Remove this section',
        '',
        '### Rollback',
        'Keep rollback',
      ].join('\n'),
      documentId: 'deploy-runbook',
      overwrite: true,
    })

    const pruned = await writer.pruneDocument({
      documentId: 'deploy-runbook',
      prunePattern: 'Deprecated Commands',
    })

    const final = await readFile(pruned.filePath, 'utf8')
    expect(final).toContain('### Overview')
    expect(final).toContain('### Rollback')
    expect(final).not.toContain('### Deprecated Commands')
    expect(final).not.toContain('Remove this section')
  })

  it('Given merge_documents in user-decides mode, then should return pending approval status', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    const result = await writer.mergeDocuments({
      sourceDocId: 'auth-v2',
      targetDocId: 'auth-v1',
      mergeMode: 'user-decides',
    })

    expect(result.status).toBe('merge-pending-approval')
    expect(result.sourceDocIds).toEqual(['auth-v2'])
  })

  it('Given merge_documents in auto mode, then should return merged status', async () => {
    const baseDir = await createTempDir()
    const writer = new MarkdownMDWriterTool({ baseDir })

    const result = await writer.mergeDocuments({
      sourceDocId: 'auth-v2',
      targetDocId: 'auth-v1',
      mergeMode: 'auto',
    })

    expect(result.status).toBe('merged')
  })
})
