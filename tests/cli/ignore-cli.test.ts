import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runIgnoreCommand } from '../../src/cli/ignore-cli'
import { parseKbFileContents } from '../../src/cli/kb-file'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-ignore-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function readKb(): Promise<{ base?: string; ignore: string[] }> {
  return parseKbFileContents(await readFile(path.join(tempDir, '.kb'), 'utf8'))
}

describe('runIgnoreCommand', () => {
  it('init scaffolds a .kb file seeded with default patterns', async () => {
    const out = await runIgnoreCommand(['init'], { cwd: tempDir })
    expect(out).toContain('Created')
    const kb = await readKb()
    expect(kb.ignore).toContain('node_modules/')
    expect(kb.ignore.length).toBeGreaterThan(0)
  })

  it('init preserves an existing base and merges patterns', async () => {
    await writeFile(
      path.join(tempDir, '.kb'),
      'base = "demo"\n\n[ignore]\npatterns = ["custom/"]\n',
      'utf8'
    )
    await runIgnoreCommand(['init'], { cwd: tempDir })
    const kb = await readKb()
    expect(kb.base).toBe('demo')
    expect(kb.ignore).toContain('custom/')
    expect(kb.ignore).toContain('node_modules/')
  })

  it('add appends new patterns and dedupes', async () => {
    await runIgnoreCommand(['add', '*.tmp', 'drafts/'], { cwd: tempDir })
    let kb = await readKb()
    expect(kb.ignore).toEqual(['*.tmp', 'drafts/'])

    await runIgnoreCommand(['add', '*.tmp', 'secret.md'], { cwd: tempDir })
    kb = await readKb()
    expect(kb.ignore).toEqual(['*.tmp', 'drafts/', 'secret.md'])
  })

  it('add updates the governing .kb file in an ancestor', async () => {
    await runIgnoreCommand(['init'], { cwd: tempDir })
    const nested = path.join(tempDir, 'packages', 'app')
    await mkdir(nested, { recursive: true })

    await runIgnoreCommand(['add', 'local.tmp'], { cwd: nested })

    // No new .kb created in the nested dir.
    await expect(readFile(path.join(nested, '.kb'), 'utf8')).rejects.toThrow()
    const kb = await readKb()
    expect(kb.ignore).toContain('local.tmp')
  })

  it('add without patterns throws a usage error', async () => {
    await expect(runIgnoreCommand(['add'], { cwd: tempDir })).rejects.toThrow(/Usage/)
  })

  it('list reports when no .kb file exists', async () => {
    const out = await runIgnoreCommand(['list'], { cwd: tempDir })
    expect(out).toContain('No .kb file found')
  })
})
