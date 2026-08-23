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
  it('[TC-OOKL] Given graph help flag, then parser returns graph-specific help text', () => {
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

  it('[TC-UIFR] Given graph entity flag, then parser returns entity lookup options', () => {
    expect(parseGraphCommand(['--entity', 'KB'])).toEqual({ entity: 'KB' })
  })

  it('[TC-P5RI] Given graph path flag, then parser returns path lookup options', () => {
    expect(parseGraphCommand(['--path', 'KB', 'SQLite'])).toEqual({
      pathFrom: 'KB',
      pathTo: 'SQLite',
    })
  })

  it('[TC-KY82] Given graph format flag, then parser returns export format option', () => {
    expect(parseGraphCommand(['--format', 'json'])).toEqual({ format: 'json' })
  })

  it('[TC-GF34] Given graph --file flag, then parser returns file coverage options', () => {
    expect(parseGraphCommand(['--file', 'share/completions/scp.fish'])).toEqual({
      file: 'share/completions/scp.fish',
    })
  })
})

describe('graph-cli help', () => {
  it('[TC-BY2A] prints grouped graph usage and examples', () => {
    const help = printGraphHelp()
    expect(help).toContain('kb graph commands')
    expect(help).toContain('Inspect:')
    expect(help).toContain('Examples:')
    expect(help).toContain('graph --file')
  })
})

describe('runGraphCommand — output routing', () => {
  it('[TC-R3PD] routes default summary output through the out parameter, not console.log', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, {}, out)

    expect(lines.some(l => l.includes('Doc ↔ code map summary'))).toBe(true)
    expect(lines.some(l => l.includes('Documents:'))).toBe(true)
    expect(lines.some(l => l.includes('Symbols:'))).toBe(true)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('[TC-5W5H] routes --format dot output through the out parameter', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, { format: 'dot' }, out)

    expect(lines.some(l => l.includes('digraph'))).toBe(true)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('[TC-I5DI] routes --format json output through the out parameter', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, { format: 'json' }, out)

    expect(lines.length).toBeGreaterThan(0)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('[TC-8UAF] reports no-path-found through the out parameter', async () => {
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, { pathFrom: 'A', pathTo: 'B' }, out)

    expect(lines.some(l => l.includes('Path search over a structural code graph is not available'))).toBe(true)
  })

  it('[TC-HNK2] reports no matching documents/symbols through the out parameter', async () => {
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand(tempDir, { entity: 'Unknown' }, out)

    expect(lines.some(l => l.includes('No documents or symbols matching'))).toBe(true)
  })

  it('[TC-CF34] reports searchable coverage for a path with a file-level code_symbol', async () => {
    const db = new Database(dbPath)
    db.prepare(
      `INSERT INTO code_file_state (file_path, content_hash, extractor, indexed_at)
       VALUES ('share/completions/scp.fish', 'abc', 'tree-sitter', ?)`
    ).run(new Date().toISOString())
    db.prepare(
      `INSERT INTO code_symbols (id, git_repo, rel_path, name, kind, source_text, content_hash, indexed_at)
       VALUES ('sym-scp', '', 'share/completions/scp.fish', 'scp.fish', 'file', 'complete -c scp', 'abc', ?)`
    ).run(new Date().toISOString())
    db.close()

    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }
    await runGraphCommand(tempDir, { file: 'share/completions/scp.fish' }, out)
    expect(lines.some(l => l.includes('Coverage for share/completions/scp.fish'))).toBe(true)
    expect(lines.some(l => l.includes('code_symbols:    1'))).toBe(true)
  })

  it('[TC-CS34] exits non-zero when code_file_state exists without searchable rows', async () => {
    const db = new Database(dbPath)
    db.prepare(
      `INSERT INTO code_file_state (file_path, content_hash, extractor, indexed_at)
       VALUES ('orphan.yaml', 'abc', 'tree-sitter', ?)`
    ).run(new Date().toISOString())
    db.close()

    const out = { log: () => {} }
    await expect(runGraphCommand(tempDir, { file: 'orphan.yaml' }, out)).rejects.toBeInstanceOf(
      GraphCommandError
    )
  })
})
