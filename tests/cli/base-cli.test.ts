import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureOperationalBaseDir, writeDefaultBase, writeSessionBase } from '../../src/cli/base-selection'
import { readKbConfig } from '../../src/cli/kb-config'
import { runMainWithOutput } from '../../src/cli/index'

let kbHomeDir: string

function makeOut() {
  const lines: string[] = []
  return {
    out: {
      log: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      write: (m: string) => lines.push(m),
    },
    lines,
  }
}

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-base-cli-'))
  process.env.KB_HOME = kbHomeDir
})

afterEach(async () => {
  delete process.env.KB_HOME
  await rm(kbHomeDir, { recursive: true, force: true })
})

describe('kb base use', () => {
  it('Given kb base use <base>, then sets activeBase and prints resolved path', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', 'mybase'], out, {} as never)
    expect(lines.join('\n')).toContain('Using base: mybase')
    expect(lines.join('\n')).toContain('mybase')
  })

  it('Given kb base use --default <base>, then sets selectedBase', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', '--default', 'mydefault'], out, {} as never)
    expect(lines.join('\n')).toContain('Default base: mydefault')
    const config = await readKbConfig()
    expect(config.selectedBase).toBe('mydefault')
  })

  it('Given kb base use --show, then prints current base config', async () => {
    await writeDefaultBase('showbase')
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', '--show'], out, {} as never)
    expect(lines.join('\n')).toContain('KB base configuration')
  })

  it('Given kb base --help, then prints base help', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', '--help'], out, {} as never)
    expect(lines.join('\n')).toContain('kb base commands')
    expect(lines.join('\n')).toContain('base delete')
  })
})

describe('kb base delete', () => {
  it('Given --force, then deletes the session directory', async () => {
    await ensureOperationalBaseDir('to-delete')
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'delete', 'to-delete', '--force'], out, {} as never)
    expect(lines.join('\n')).toContain('Deleted base: to-delete')
  })

  it('Given --force and base is activeBase, then clears it from config', async () => {
    await ensureOperationalBaseDir('active')
    await writeSessionBase('active')
    const { out } = makeOut()
    await runMainWithOutput(['base', 'delete', 'active', '--force'], out, {} as never)
    const config = await readKbConfig()
    expect(config.activeBase).toBeUndefined()
  })

  it('Given --force and base is selectedBase, then clears it from config', async () => {
    await ensureOperationalBaseDir('selected')
    await writeDefaultBase('selected')
    const { out } = makeOut()
    await runMainWithOutput(['base', 'delete', 'selected', '--force'], out, {} as never)
    const config = await readKbConfig()
    expect(config.selectedBase).toBeUndefined()
  })

  it('Given no --force in TUI mode, then does NOT hang — returns prompt to use --force', async () => {
    await ensureOperationalBaseDir('catalog')
    const { out, lines } = makeOut()
    // Must resolve quickly (no readline prompt) — this was the hang bug
    await runMainWithOutput(['base', 'delete', 'catalog'], out, {} as never, 'tui')
    expect(lines.join('\n')).toContain('--force')
    expect(lines.join('\n')).toContain('catalog')
  })

  it('Given no --force in CLI mode with non-TTY stdin, then aborts without deleting', async () => {
    await ensureOperationalBaseDir('safe')
    const { out, lines } = makeOut()
    // process.stdin.isTTY is false in test env — promptConfirm returns false → "Aborted."
    await runMainWithOutput(['base', 'delete', 'safe'], out, {} as never, 'cli')
    expect(lines.join('\n')).toContain('Aborted')
  })

  it('Given no base name, then prints help', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'delete'], out, {} as never)
    expect(lines.join('\n')).toContain('base delete')
  })

  it('Given --help, then prints delete help', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'delete', '--help'], out, {} as never)
    expect(lines.join('\n')).toContain('base delete')
    expect(lines.join('\n')).toContain('--force')
  })
})

describe('kb use (backward-compat alias)', () => {
  it('Given kb use <base>, then behaves identically to kb base use <base>', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['use', 'aliasbase'], out, {} as never)
    expect(lines.join('\n')).toContain('Using base: aliasbase')
  })
})
