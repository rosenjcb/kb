import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/client/cli/remote-commands.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@kb/client/cli/remote-commands.js')>()
  return {
    ...actual,
    runRemoteCliCommand: vi.fn().mockResolvedValue(0),
  }
})

import { resolveBaseToDir, writeSessionBase } from '@kb/core/storage/base-selection.js'
import { runMainWithOutput } from '@kb/client/cli/index.js'
import { runRemoteCliCommand } from '@kb/client/cli/remote-commands.js'

const mockRunRemoteCliCommand = vi.mocked(runRemoteCliCommand)

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
  mockRunRemoteCliCommand.mockReset()
  mockRunRemoteCliCommand.mockResolvedValue(0)
})

afterEach(async () => {
  delete process.env.KB_HOME
  await rm(kbHomeDir, { recursive: true, force: true })
})

describe('kb base use', () => {
  it('[TC-6] Given kb base use <base>, then sets activeBase and prints resolved path', async () => {
    await initBase('mybase')
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', 'mybase'], out, {} as never)
    expect(lines.join('\n')).toContain('Using base: mybase')
    expect(lines.join('\n')).toContain('mybase')
    expect(mockRunRemoteCliCommand).not.toHaveBeenCalled()
  })

  it('[TC-8] Given kb base use <base> that does not exist, then errors with server-managed guidance', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', 'ghost'], out, {} as never)
    expect(lines.join('\n')).toContain('ghost')
    expect(lines.join('\n')).toContain('KB_GIT_REPOS')
  })

  it('[TC-9] Given kb base use --show, then prints current base config', async () => {
    await initBase('showbase')
    await writeSessionBase('showbase')
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', 'use', '--show'], out, {} as never)
    expect(lines.join('\n')).toContain('KB base configuration')
    expect(lines.join('\n')).toContain('Active base: showbase')
  })

  it('[TC-10] Given kb base --help, then prints base help', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['base', '--help'], out, {} as never)
    expect(lines.join('\n')).toContain('kb base commands')
    expect(lines.join('\n')).toContain('base delete')
    expect(mockRunRemoteCliCommand).not.toHaveBeenCalled()
  })
})

describe('kb base list / delete (remote)', () => {
  it('[TC-11] Given kb base list, then forwards to runRemoteCliCommand', async () => {
    const { out } = makeOut()
    await runMainWithOutput(['base', 'list'], out, {} as never)
    expect(mockRunRemoteCliCommand).toHaveBeenCalledTimes(1)
    expect(mockRunRemoteCliCommand).toHaveBeenCalledWith(
      ['base', 'list'],
      out,
      expect.anything(),
      'cli'
    )
  })

  it('[TC-12] Given kb base delete --force, then forwards to runRemoteCliCommand', async () => {
    const { out } = makeOut()
    await runMainWithOutput(['base', 'delete', 'to-delete', '--force'], out, {} as never)
    expect(mockRunRemoteCliCommand).toHaveBeenCalledTimes(1)
    expect(mockRunRemoteCliCommand).toHaveBeenCalledWith(
      ['base', 'delete', 'to-delete', '--force'],
      out,
      expect.anything(),
      'cli'
    )
  })

  it('[TC-13] Given base delete without --force in TUI, then forwards to remote (server enforces --force)', async () => {
    const { out } = makeOut()
    await runMainWithOutput(['base', 'delete', 'catalog'], out, {} as never, 'tui')
    expect(mockRunRemoteCliCommand).toHaveBeenCalledWith(
      ['base', 'delete', 'catalog'],
      out,
      expect.anything(),
      'tui'
    )
  })
})

describe('kb --help', () => {
  it('[TC-14] Given kb --help, then prints --host and core commands', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['--help'], out, {} as never)

    const text = lines.join('\n')
    expect(text).toContain('--host')
    expect(text).toContain('kb sync')
    expect(text).toContain('kb query')
    expect(mockRunRemoteCliCommand).not.toHaveBeenCalled()
  })
})
