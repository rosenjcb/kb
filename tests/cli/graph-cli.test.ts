import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GraphCommandError,
  parseGraphCommand,
  printGraphHelp,
  runGraphCommand,
} from '@kb/core/cli/graph-cli.js'
import { runMigrations } from '@kb/core/core/db-migrations.js'

let tempDir: string
let dbPath: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-graph-cli-test-'))
  dbPath = path.join(tempDir, '.kb-index.sqlite')
  const db = new Database(dbPath)
  runMigrations(db)
  db.close()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('graph-cli parsing', () => {
  it('[TC-234] Given graph help flag, then parser returns graph-specific help text', () => {
    try {
      parseGraphCommand(['--help'])
      throw new Error('expected help error')
    } catch (error) {
      expect(error).toBeInstanceOf(GraphCommandError)
      expect((error as GraphCommandError).exitCode).toBe(0)
      expect((error as Error).message).toContain('kb graph commands')
      expect((error as Error).message).toContain('kb graph --entity <name>')
    }
  })

  it('[TC-235] Given graph entity flag, then parser returns entity lookup options', () => {
    expect(parseGraphCommand(['--entity', 'KB'])).toEqual({ entity: 'KB' })
  })

  it('[TC-236] Given graph path flag, then parser returns path lookup options', () => {
    expect(parseGraphCommand(['--path', 'KB', 'SQLite'])).toEqual({
      pathFrom: 'KB',
      pathTo: 'SQLite',
    })
  })

  it('[TC-237] Given graph format flag, then parser returns export format option', () => {
    expect(parseGraphCommand(['--format', 'json'])).toEqual({ format: 'json' })
  })
})

describe('graph-cli help', () => {
  it('[TC-238] prints grouped graph usage and examples', () => {
    const help = printGraphHelp()
    expect(help).toContain('kb graph commands')
    expect(help).toContain('Inspect:')
    expect(help).toContain('Examples:')
  })
})

describe('runGraphCommand — output routing', () => {
  it('[TC-239] routes default summary output through the out parameter, not console.log', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, {}, out)

    expect(lines.some(l => l.includes('Knowledge graph summary'))).toBe(true)
    expect(lines.some(l => l.includes('Triplets:'))).toBe(true)
    expect(lines.some(l => l.includes('Symbols:'))).toBe(true)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('[TC-240] routes --format dot output through the out parameter', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, { format: 'dot' }, out)

    expect(lines.some(l => l.includes('digraph'))).toBe(true)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('[TC-241] routes --format json output through the out parameter', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, { format: 'json' }, out)

    expect(lines.length).toBeGreaterThan(0)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('[TC-242] reports no-path-found through the out parameter', async () => {
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, { pathFrom: 'A', pathTo: 'B' }, out)

    expect(lines.some(l => l.includes('No path found'))).toBe(true)
  })

  it('[TC-243] reports entity-not-found through the out parameter', async () => {
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, { entity: 'Unknown' }, out)

    expect(lines.some(l => l.includes('not found') || l.includes('No facts found'))).toBe(true)
  })
})
