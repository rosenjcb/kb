import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DocsMergeError,
  parseDocsMergeCommand,
  runDocsMerge,
} from '../../src/cli/docs-merge-cli'
import { SqliteDocumentWriter } from '../../src/tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'
import type { LLMProvider, LLMResponse } from '../../src/core/types'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempBase(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-merge-cli-'))
  tempDirs.push(dir)
  return dir
}

async function seedDocument(
  baseDir: string,
  input: { title: string; documentId?: string; content: string; tags?: string[] }
): Promise<void> {
  const writer = new SqliteDocumentWriter({ baseDir })
  await writer.writeDocument({
    title: input.title,
    documentId: input.documentId,
    content: input.content,
    tags: input.tags,
  })
}

function makeFakeLLM(mergedBody: string): LLMProvider {
  return {
    name: 'fake',
    model: 'fake-model',
    supportsStreaming: false,
    call: vi.fn().mockResolvedValue({
      text: mergedBody,
      stopReason: 'end_turn',
      toolUses: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    } satisfies LLMResponse),
  }
}

function makeOut() {
  const lines: string[] = []
  return {
    out: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m), write: (m: string) => lines.push(m) },
    lines,
  }
}

// ─── Parser ──────────────────────────────────────────────────────────────────

describe('parseDocsMergeCommand', () => {
  it('Given target and one source, then parses both ids', () => {
    const parsed = parseDocsMergeCommand(['target-doc', 'source-doc'])
    expect(parsed.targetDocId).toBe('target-doc')
    expect(parsed.sourceDocIds).toEqual(['source-doc'])
    expect(parsed.base).toBeUndefined()
  })

  it('Given multiple sources, then captures all', () => {
    const parsed = parseDocsMergeCommand(['target', 'src-a', 'src-b', 'src-c'])
    expect(parsed.sourceDocIds).toEqual(['src-a', 'src-b', 'src-c'])
  })

  it('Given ids with spaces/caps, then normalizes to slugs', () => {
    const parsed = parseDocsMergeCommand(['My Target Doc', 'My Source Doc'])
    expect(parsed.targetDocId).toBe('my-target-doc')
    expect(parsed.sourceDocIds).toEqual(['my-source-doc'])
  })

  it('Given --base flag, then captures base', () => {
    const parsed = parseDocsMergeCommand(['target', 'source', '--base', 'dogfood'])
    expect(parsed.base).toBe('dogfood')
  })

  it('Given only one positional arg, then throws usage error', () => {
    expect(() => parseDocsMergeCommand(['target-only'])).toThrow(DocsMergeError)
  })

  it('Given no args, then throws with exit code 0', () => {
    try {
      parseDocsMergeCommand([])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsMergeError)
      expect((e as DocsMergeError).exitCode).toBe(0)
    }
  })

  it('Given --help, then throws with exit code 0', () => {
    try {
      parseDocsMergeCommand(['--help'])
    } catch (e) {
      expect(e).toBeInstanceOf(DocsMergeError)
      expect((e as DocsMergeError).exitCode).toBe(0)
    }
  })

  it('Given unknown flag, then throws', () => {
    expect(() => parseDocsMergeCommand(['target', 'source', '--unknown'])).toThrow(DocsMergeError)
  })
})

// ─── runDocsMerge ─────────────────────────────────────────────────────────────

describe('runDocsMerge', () => {
  it('Given valid target and source, then writes merged content to target and deletes source', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Target Doc',
      documentId: 'target-doc',
      content: 'Target body content.',
      tags: ['facts'],
    })
    await seedDocument(baseDir, {
      title: 'Source Doc',
      documentId: 'source-doc',
      content: 'Source body content.',
    })

    const llm = makeFakeLLM('## Merged\n\nCombined content from both documents.')
    const { out } = makeOut()

    await runDocsMerge(
      { targetDocId: 'target-doc', sourceDocIds: ['source-doc'] },
      baseDir,
      llm,
      out
    )

    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })

    const targetContent = indexer.getDocumentContent('target-doc')
    expect(targetContent).toContain('## Merged')
    expect(targetContent).toContain('Combined content from both documents.')
    expect(targetContent).toContain('# Target Doc')

    expect(indexer.getDocumentContent('source-doc')).toBeUndefined()
  })

  it('Given multiple sources, then deletes all sources', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Target', documentId: 'target', content: 'T body.' })
    await seedDocument(baseDir, { title: 'Source A', documentId: 'source-a', content: 'A body.' })
    await seedDocument(baseDir, { title: 'Source B', documentId: 'source-b', content: 'B body.' })

    const llm = makeFakeLLM('Merged body.')
    const { out } = makeOut()

    await runDocsMerge(
      { targetDocId: 'target', sourceDocIds: ['source-a', 'source-b'] },
      baseDir,
      llm,
      out
    )

    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })
    expect(indexer.getDocumentContent('source-a')).toBeUndefined()
    expect(indexer.getDocumentContent('source-b')).toBeUndefined()
  })

  it('Given target not found, then throws DocsMergeError', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Source', documentId: 'source', content: 'body' })

    const llm = makeFakeLLM('merged')
    const { out } = makeOut()

    await expect(
      runDocsMerge({ targetDocId: 'missing-target', sourceDocIds: ['source'] }, baseDir, llm, out)
    ).rejects.toThrow(DocsMergeError)
  })

  it('Given source not found, then throws DocsMergeError', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Target', documentId: 'target', content: 'body' })

    const llm = makeFakeLLM('merged')
    const { out } = makeOut()

    await expect(
      runDocsMerge({ targetDocId: 'target', sourceDocIds: ['missing-source'] }, baseDir, llm, out)
    ).rejects.toThrow(DocsMergeError)
  })

  it('Given LLM returns empty content, then throws DocsMergeError', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Target', documentId: 'target', content: 'body' })
    await seedDocument(baseDir, { title: 'Source', documentId: 'source', content: 'body' })

    const llm = makeFakeLLM('   ')
    const { out } = makeOut()

    await expect(
      runDocsMerge({ targetDocId: 'target', sourceDocIds: ['source'] }, baseDir, llm, out)
    ).rejects.toThrow(DocsMergeError)
  })

  it('Given merge succeeds, then LLM receives prompt containing both doc contents', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, { title: 'Target', documentId: 'target', content: 'Target fact.' })
    await seedDocument(baseDir, { title: 'Source', documentId: 'source', content: 'Source fact.' })

    const llm = makeFakeLLM('merged body')
    const { out } = makeOut()

    await runDocsMerge({ targetDocId: 'target', sourceDocIds: ['source'] }, baseDir, llm, out)

    const callArgs = (llm.call as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const prompt = callArgs.messages[0].content as string
    expect(prompt).toContain('Target fact.')
    expect(prompt).toContain('Source fact.')
  })

  it('Given merge succeeds, then target metadata (tags, createdAt) is preserved', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Target',
      documentId: 'target',
      content: 'body',
      tags: ['architecture', 'core'],
    })
    await seedDocument(baseDir, { title: 'Source', documentId: 'source', content: 'body' })

    const llm = makeFakeLLM('merged body')
    const { out } = makeOut()

    await runDocsMerge({ targetDocId: 'target', sourceDocIds: ['source'] }, baseDir, llm, out)

    const dbPath = path.join(baseDir, '.kb-index.sqlite')
    const indexer = new SqliteKbIndexer({ dbPath })
    const content = indexer.getDocumentContent('target') ?? ''
    expect(content).toContain('Tags: architecture, core')
  })
})
