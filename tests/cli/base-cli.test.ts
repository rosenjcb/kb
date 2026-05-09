import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ensureOperationalBaseDir,
  resolveBaseToDir,
  writeDefaultBase,
  writeSessionBase,
} from '../../src/cli/base-selection'
import { runMainWithOutput } from '../../src/cli/index'
import { readKbConfig } from '../../src/cli/kb-config'

let kbHomeDir: string

/** Create a base directory with the sqlite marker so it looks initialized. */
async function initBase(name: string): Promise<void> {
  const dir = resolveBaseToDir(name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, '.kb-index.sqlite'), '', 'utf8')
}

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
    await initBase('mybase')
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', 'mybase'], out, {} as never)
    expect(lines.join('\n')).toContain('Using base: mybase')
    expect(lines.join('\n')).toContain('mybase')
  })

  it('Given kb base use --default <base>, then sets both defaultBase and activeBase', async () => {
    await initBase('mydefault')
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', '--default', 'mydefault'], out, {} as never)
    expect(lines.join('\n')).toContain('Default base: mydefault')
    const config = await readKbConfig()
    expect(config.defaultBase).toBe('mydefault')
    expect(config.activeBase).toBe('mydefault')
  })

  it('Given kb base use <base> that does not exist, then errors and suggests kb init', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', 'ghost'], out, {} as never)
    expect(lines.join('\n')).toContain('ghost')
    expect(lines.join('\n')).toContain('kb init')
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

  it('Given --force and base is defaultBase, then clears it from config', async () => {
    await ensureOperationalBaseDir('selected')
    await writeDefaultBase('selected')
    const { out } = makeOut()
    await runMainWithOutput(['base', 'delete', 'selected', '--force'], out, {} as never)
    const config = await readKbConfig()
    expect(config.defaultBase).toBeUndefined()
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
    await initBase('aliasbase')
    const { out, lines } = makeOut()
    await runMainWithOutput(['use', 'aliasbase'], out, {} as never)
    expect(lines.join('\n')).toContain('Using base: aliasbase')
  })
})

describe('kb init help', () => {
  it('Given kb init --help, then points refresh workflows to kb scan', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['init', '--help'], out, {} as never)

    const text = lines.join('\n')
    expect(text).toContain('kb init command')
    expect(text).toContain('Use kb scan')
    expect(text).not.toContain('--rescan')
  })

  it('Given kb --help, then prints scan examples', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['--help'], out, {} as never)

    const text = lines.join('\n')
    expect(text).toContain('kb scan --base dogfood')
    expect(text).toContain('kb scan --base dogfood --apply')
    expect(text).toContain('kb sync')
  })

  it('Given /scan --help in TUI mode, then prints slash-form scan guidance', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['scan', '--help'], out, {} as never, 'tui')

    const text = lines.join('\n')
    expect(text).toContain('/scan --base dogfood')
    expect(text).toContain('/base use <base>')
  })
})
