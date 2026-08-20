import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@kb/core/ops/init-cli.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@kb/core/ops/init-cli.js')>()
  return {
    ...actual,
    runKbInit: vi.fn().mockResolvedValue({}),
  }
})

import { runKbInit } from '@kb/core/ops/init-cli.js'
import { ensureBaseExists, resolveBaseToDir } from '@kb/core/storage/base-selection.js'
import { runServerBaseCommand } from '@kb/server/base-cli.js'

const mockRunKbInit = vi.mocked(runKbInit)

let kbHomeDir: string
let savedExitCode: typeof process.exitCode

async function initBase(name: string): Promise<void> {
  const dir = resolveBaseToDir(name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, '.kb-index.sqlite'), '', 'utf8')
}

function makeOut() {
  const lines: string[] = []
  return {
    out: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) },
    lines,
  }
}

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-server-base-cli-'))
  process.env.KB_HOME = kbHomeDir
  savedExitCode = process.exitCode
  process.exitCode = undefined
  mockRunKbInit.mockClear()
  mockRunKbInit.mockResolvedValue({} as never)
})

afterEach(async () => {
  delete process.env.KB_HOME
  process.exitCode = savedExitCode
  await rm(kbHomeDir, { recursive: true, force: true })
})

describe('kb-server base create', () => {
  it('[TC-BZDP] refuses to create the reserved default base', async () => {
    const { out, lines } = makeOut()
    await runServerBaseCommand(['create', '--base', 'default', '--git', 'https://x/y'], out)
    expect(lines.join('\n')).toContain('kb-server init')
    expect(mockRunKbInit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('[TC-J398] requires at least one --git for a named base', async () => {
    const { out, lines } = makeOut()
    await runServerBaseCommand(['create', '--base', 'acme'], out)
    expect(lines.join('\n')).toContain('At least one repo')
    expect(mockRunKbInit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('[TC-1E89] refuses to create a base that already exists', async () => {
    await initBase('acme')
    const { out, lines } = makeOut()
    await runServerBaseCommand(['create', '--base', 'acme', '--git', 'https://x/y'], out)
    expect(lines.join('\n')).toContain('already exists')
    expect(mockRunKbInit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('[TC-FI59] builds a new named base from its repos', async () => {
    const { out } = makeOut()
    await runServerBaseCommand(
      ['create', '--base', 'acme', '--git', 'https://github.com/x/y', '--git', 'https://github.com/a/b'],
      out
    )
    expect(mockRunKbInit).toHaveBeenCalledTimes(1)
    const arg = mockRunKbInit.mock.calls[0]?.[0]
    expect(arg?.base).toBe('acme')
    expect(arg?.gitTargets?.map(t => t.url)).toEqual([
      'https://github.com/x/y',
      'https://github.com/a/b',
    ])
  })
})

describe('kb-server base add-repo', () => {
  it('[TC-OJWT] refuses to add repos to a non-existent named base', async () => {
    const { out, lines } = makeOut()
    await runServerBaseCommand(['add-repo', '--base', 'ghost', '--git', 'https://x/y'], out)
    expect(lines.join('\n')).toContain('Create it first')
    expect(mockRunKbInit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('[TC-PT5O] allows adding a repo to the empty default base', async () => {
    const { out } = makeOut()
    await runServerBaseCommand(['add-repo', '--base', 'default', '--git', 'https://github.com/x/y'], out)
    expect(mockRunKbInit).toHaveBeenCalledTimes(1)
    expect(mockRunKbInit.mock.calls[0]?.[0]?.base).toBe('default')
  })

  it('[TC-VLX0] requires at least one --git', async () => {
    await initBase('acme')
    const { out, lines } = makeOut()
    await runServerBaseCommand(['add-repo', '--base', 'acme'], out)
    expect(lines.join('\n')).toContain('At least one repo')
    expect(mockRunKbInit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})

describe('kb-server base list / delete', () => {
  it('[TC-D8ZT] reports when no bases are initialized', async () => {
    const { out, lines } = makeOut()
    await runServerBaseCommand(['list'], out)
    expect(lines.join('\n')).toContain('No initialized bases')
  })

  it('[TC-QCCG] lists an initialized base', async () => {
    await initBase('acme')
    const { out, lines } = makeOut()
    await runServerBaseCommand(['list'], out)
    expect(lines.join('\n')).toContain('acme')
  })

  it('[TC-EMTY] marks a base with a genuinely empty (materialized but unindexed) index as [empty]', async () => {
    await ensureBaseExists('fresh')
    const { out, lines } = makeOut()
    await runServerBaseCommand(['list'], out)
    const line = lines.join('\n')
    expect(line).toContain('fresh')
    expect(line).toContain('[empty]')
  })

  it('[TC-SU4B] delete requires a base name', async () => {
    const { out, lines } = makeOut()
    await runServerBaseCommand(['delete', '--yes'], out)
    expect(lines.join('\n')).toContain('--base <name> is required')
    expect(process.exitCode).toBe(1)
  })

  it('[TC-3T44] deletes a base with --yes', async () => {
    await initBase('acme')
    const { out, lines } = makeOut()
    await runServerBaseCommand(['delete', '--base', 'acme', '--yes'], out)
    expect(lines.join('\n')).toContain('Deleted base: acme')
  })

  it('[TC-WTZX] help lists the base subcommands', async () => {
    const { out, lines } = makeOut()
    await runServerBaseCommand([], out)
    const text = lines.join('\n')
    expect(text).toContain('create')
    expect(text).toContain('add-repo')
    expect(text).toContain('delete')
  })
})
