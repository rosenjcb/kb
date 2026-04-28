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
  it('Given id selector, then parses normalized id mode', () => {
    const parsed = parseViewCommand(['KB Base Selection And Usage'])

    expect(parsed.selector).toEqual({
      mode: 'id',
      value: 'kb-base-selection-and-usage',
    })
    expect(parsed.output).toBe('human')
  })

  it('Given title and output flags, then parses title mode and json output', () => {
    const parsed = parseViewCommand([
      '--title',
      'KB Base Selection and Usage',
      '--output',
      'json',
      '--base',
      'dogfood',
    ])

    expect(parsed.selector).toEqual({
      mode: 'title',
      value: 'KB Base Selection and Usage',
    })
    expect(parsed.output).toBe('json')
    expect(parsed.base).toBe('dogfood')
  })

  it('Given id and title selectors together, then throws explicit error', () => {
    expect(() => parseViewCommand(['doc-id', '--title', 'Title'])).toThrow(
      'kb docs view accepts either <document-id> or --title, not both.'
    )
  })

  it('Given unsupported output, then throws explicit error', () => {
    expect(() => parseViewCommand(['doc-id', '--output', 'yaml'])).toThrow(
      'Unsupported output mode: yaml. Use human or json.'
    )
  })
})

describe('list-cli parsing', () => {
  it('Given no flags, then parses default limit and human output', () => {
    const parsed = parseListCommand([])

    expect(parsed.limit).toBe(20)
    expect(parsed.output).toBe('human')
  })

  it('Given flags, then parses limit, base, and json output', () => {
    const parsed = parseListCommand(['--base', 'dogfood', '--limit', '5', '--output', 'json'])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.limit).toBe(5)
    expect(parsed.output).toBe('json')
  })

  it('Given positional arg, then throws explicit error', () => {
    expect(() => parseListCommand(['extra'])).toThrow(
      'kb docs list does not accept positional arguments.'
    )
  })
})

describe('view-cli runtime', () => {
  it('Given document id, then prints full document body with metadata header', async () => {
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

  it('Given exact title selector, then returns matching document json payload', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'KB Base Selection and Usage',
      documentId: 'kb-base-selection-and-usage',
      content: 'Base selection uses kb use and kb default.\n',
      type: 'reference',
    })

    const result = await runViewCommand([
      '--title',
      'KB Base Selection and Usage',
      '--output',
      'json',
      '--base',
      baseDir,
    ])

    expect(result.output).toContain('"id": "kb-base-selection-and-usage"')
    expect(result.output).toContain('"title": "KB Base Selection and Usage"')
    expect(result.output).toContain('Base selection uses kb use and kb default.')
  })

  it('Given missing document, then throws not found error', async () => {
    const baseDir = await createTempBase()

    await expect(runViewCommand(['missing-doc', '--base', baseDir])).rejects.toThrow(
      'Document not found: missing-doc'
    )
  })

  it('Given duplicate exact title matches, then throws ambiguity error with exit code 2', async () => {
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
  it('Given documents in a base, then lists metadata in human output', async () => {
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

  it('Given json output, then returns metadata-only document list', async () => {
    const baseDir = await createTempBase()
    await seedDocument(baseDir, {
      title: 'CLI Facts',
      documentId: 'cli-facts',
      content: 'Use `kb query` first.\n',
      type: 'reference',
    })

    const result = await runListCommand(['--base', baseDir, '--output', 'json'])

    expect(result.output).toContain('"documents"')
    expect(result.output).toContain('"id": "cli-facts"')
    expect(result.output).not.toContain('Use `kb query` first.')
  })
})
