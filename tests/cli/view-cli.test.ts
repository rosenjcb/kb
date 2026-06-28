import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ViewCommandError,
  parseListCommand,
  parseViewCommand,
  runListCommand,
  runViewCommand,
} from '../../src/cli/view-cli'
import { SqliteDocumentWriter } from '../../src/tools/sqlite-document-writer'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempBase(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-view-cli-'))
  tempDirs.push(dir)
  return dir
}

async function seedDocument(
  baseDir: string,
  input: {
    title: string
    documentId?: string
    content: string
    type?: 'howto' | 'introduction' | 'reference' | 'decision' | 'runbook'
    tags?: string[]
  }
): Promise<void> {
  const writer = new SqliteDocumentWriter({ baseDir })
  await writer.writeDocument({
    title: input.title,
    documentId: input.documentId,
    content: input.content,
    type: input.type,
    tags: input.tags,
  })
}

describe('view-cli parsing', () => {
  it('[TC-499] Given id selector, then parses normalized id mode', () => {
    const parsed = parseViewCommand(['KB Base Selection And Usage'])

    expect(parsed.selector).toEqual({
      mode: 'id',
      value: 'kb-base-selection-and-usage',
    })
  })

  it('[TC-500] Given title and base flags, then parses title mode with base', () => {
    const parsed = parseViewCommand([
      '--title',
      'KB Base Selection and Usage',
      '--base',
      'dogfood',
    ])

    expect(parsed.selector).toEqual({
      mode: 'title',
      value: 'KB Base Selection and Usage',
    })
    expect(parsed.base).toBe('dogfood')
  })

  it('[TC-501] Given id and title selectors together, then throws explicit error', () => {
    expect(() => parseViewCommand(['doc-id', '--title', 'Title'])).toThrow(
      'kb docs view accepts either <document-id> or --title, not both.'
    )
  })

  it('[TC-502] Given unknown flag, then throws explicit error', () => {
    expect(() => parseViewCommand(['doc-id', '--output', 'yaml'])).toThrow('Unknown option: --output')
  })
})

describe('list-cli parsing', () => {
  it('[TC-503] Given no flags, then parses unlimited output by default', () => {
    const parsed = parseListCommand([])

    expect(parsed.limit).toBeUndefined()
  })

  it('[TC-504] Given flags, then parses limit and base', () => {
    const parsed = parseListCommand(['--base', 'dogfood', '--limit', '5'])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.limit).toBe(5)
  })

  it('[TC-505] Given positional arg, then throws explicit error', () => {
    expect(() => parseListCommand(['extra'])).toThrow(
      'kb docs list does not accept positional arguments.'
    )
  })
})

describe('view-cli runtime', () => {
  it('[TC-506] Given document id, then prints full document body with metadata header', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'CLI Facts',
      documentId: 'cli-facts',
      content: 'Use `kb query` first.\n',
      type: 'reference',
      tags: ['cli', 'usage'],
    })

    const result = await runViewCommand(['cli-facts', '--base', baseDir])

    expect(result.output).toContain('# CLI Facts')
    expect(result.output).toContain('ID: cli-facts')
    expect(result.output).toContain('Type: reference')
    expect(result.output).toContain('Tags: cli, usage')
    expect(result.output).toContain('Use `kb query` first.')
    expect(result.output.match(/^Created:/gm)).toHaveLength(1)
  })

  it('[TC-507] Given exact title selector, then returns matching document', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'KB Base Selection and Usage',
      documentId: 'kb-base-selection-and-usage',
      content: 'Base selection uses kb base use and kb base use --default.\n',
      type: 'reference',
    })

    const result = await runViewCommand([
      '--title',
      'KB Base Selection and Usage',
      '--base',
      baseDir,
    ])

    expect(result.output).toContain('KB Base Selection and Usage')
    expect(result.output).toContain('Base selection uses kb base use and kb base use --default.')
  })

  it('[TC-508] Given missing document, then throws not found error', async () => {
    const baseDir = await createTempBase()

    await expect(runViewCommand(['missing-doc', '--base', baseDir])).rejects.toThrow(
      'Document not found: missing-doc'
    )
  })

  it('[TC-509] Given duplicate exact title matches, then throws ambiguity error with exit code 2', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'Shared Title',
      documentId: 'shared-title-one',
      content: 'First.\n',
      type: 'reference',
    })
    await seedDocument(baseDir, {
      title: 'Shared Title',
      documentId: 'shared-title-two',
      content: 'Second.\n',
      type: 'reference',
    })

    try {
      await runViewCommand(['--title', 'Shared Title', '--base', baseDir])
      throw new Error('Expected ambiguity error')
    } catch (error) {
      expect(error).toBeInstanceOf(ViewCommandError)
      const viewError = error as ViewCommandError
      expect(viewError.exitCode).toBe(2)
      expect(viewError.message).toContain('Ambiguous title match: Shared Title')
      expect(viewError.message).toContain('shared-title-one')
      expect(viewError.message).toContain('shared-title-two')
    }
  })
})

describe('list-cli runtime', () => {
  it('[TC-510] Given documents in a base, then lists metadata in human output', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'CLI Facts',
      documentId: 'cli-facts',
      content: 'Use `kb query` first.\n',
      type: 'reference',
      tags: ['cli'],
    })
    await seedDocument(baseDir, {
      title: 'Architecture Notes',
      documentId: 'architecture-notes',
      content: 'System overview.\n',
      type: 'introduction',
    })

    const result = await runListCommand(['--base', baseDir, '--limit', '10'])

    expect(result.output).toContain('# KB Documents')
    expect(result.output).toContain('Count: 2')
    expect(result.output).toContain('- cli-facts (title="CLI Facts"; type=reference; tags=cli;')
    expect(result.output).toContain(
      '- architecture-notes (title="Architecture Notes"; type=introduction;'
    )
  })

  it('[TC-511] Given base filter, then returns document list for that base', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'CLI Facts',
      documentId: 'cli-facts',
      content: 'Use `kb query` first.\n',
      type: 'reference',
    })

    const result = await runListCommand(['--base', baseDir])

    expect(result.output).toContain('cli-facts')
  })

  it('[TC-512] Given more than twenty documents, then docs list shows all by default', async () => {
    const baseDir = await createTempBase()
    for (let index = 1; index <= 25; index += 1) {
      await seedDocument(baseDir, {
        title: `Doc ${index}`,
        documentId: `doc-${index}`,
        content: `Content ${index}\n`,
        type: 'reference',
      })
    }

    const result = await runListCommand(['--base', baseDir])

    expect(result.output).toContain('Count: 25')
    expect(result.output).toContain('- doc-25 (title="Doc 25"; type=reference;')
    expect(result.output).toContain('- doc-1 (title="Doc 1"; type=reference;')
  })
})
