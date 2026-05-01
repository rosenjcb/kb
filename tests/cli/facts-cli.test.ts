import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FactsCommandError, parseFactsCommand, runFactsCommand } from '../../src/cli/facts-cli'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function tempBase(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-facts-cli-'))
  tempDirs.push(dir)
  return dir
}

describe('parseFactsCommand', () => {
  it('Given list subcommand, then parses limit and output', () => {
    const p = parseFactsCommand(['list', '--limit', '5', '--output', 'json', '--base', 'dogfood'])
    expect(p).toEqual({ sub: 'list', base: 'dogfood', limit: 5, output: 'json' })
  })

  it('Given --help, then throws FactsCommandError exit 0', () => {
    try {
      parseFactsCommand(['--help'])
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(FactsCommandError)
      expect((e as FactsCommandError).exitCode).toBe(0)
    }
  })

  it('Given search without query, then throws', () => {
    expect(() => parseFactsCommand(['search'])).toThrow(FactsCommandError)
  })
})

describe('runFactsCommand', () => {
  it('Given seeded facts, list and search return human text', async () => {
    const baseDir = await tempBase()
    const ix = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    ix.upsertFact({
      factText: 'Unique orchid retrieval phrase for FTS.',
      sourceKind: 'submit',
      sourceRef: 't',
      confidence: 0.9,
    })
    ix.close()

    const listed = await runFactsCommand(['list', '--base', baseDir, '--limit', '10'])
    expect(listed).toContain('Unique orchid retrieval')

    const searched = await runFactsCommand(['search', 'orchid retrieval', '--base', baseDir])
    expect(searched).toContain('Unique orchid')
  })

  it('Given fact id, show returns that row', async () => {
    const baseDir = await tempBase()
    const ix = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    ix.upsertFact({
      factText: 'Show by id test fact body.',
      sourceKind: 'submit',
      sourceRef: 't',
      confidence: 0.9,
    })
    const rows = ix.searchFacts('Show by id', 1)
    const id = rows[0]?.id
    expect(id).toBeDefined()
    if (!id) throw new Error('expected fact id')
    ix.close()

    const out = await runFactsCommand(['show', id, '--base', baseDir])
    expect(out).toContain('Show by id test fact body.')
    expect(out).toContain(`id: ${id}`)
  })
})
