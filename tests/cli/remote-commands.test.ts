import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverRemoteDefaultBase,
  dispatchRemoteChatStreamEvent,
  isClientLocalCommand,
  resolveDisplayBase,
} from '@kb/client/cli/remote-commands.js'

describe('isClientLocalCommand', () => {
  it('[TC-27] keeps mcp/skills/uninstall/sync/base use on the client', () => {
    expect(isClientLocalCommand(['mcp', 'status'])).toBe(true)
    expect(isClientLocalCommand(['mcp', 'install', '--host', 'localhost:38117'])).toBe(true)
    expect(isClientLocalCommand(['skills', 'install'])).toBe(true)
    expect(isClientLocalCommand(['uninstall'])).toBe(true)
    expect(isClientLocalCommand(['sync'])).toBe(true)
    expect(isClientLocalCommand(['base', 'use', 'demo'])).toBe(true)
    expect(isClientLocalCommand(['base', '--help'])).toBe(true)
    // `base delete` is refused client-side (operator action), so it stays local rather
    // than forwarding to the server admin CLI.
    expect(isClientLocalCommand(['base', 'delete', 'x'])).toBe(true)
  })

  it('[TC-29] still forwards server-backed commands remotely', () => {
    expect(isClientLocalCommand(['query', 'hi'])).toBe(false)
    expect(isClientLocalCommand(['base', 'list'])).toBe(false)
    expect(isClientLocalCommand(['docs', 'list'])).toBe(false)
  })
})

describe('discoverRemoteDefaultBase', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('[TC-52] returns the base reported by the server health probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, base: 'raylib' }), { status: 200 })),
    )
    await expect(discoverRemoteDefaultBase({})).resolves.toBe('raylib')
  })

  it('[TC-53] returns undefined when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await expect(discoverRemoteDefaultBase({})).resolves.toBeUndefined()
  })
})

describe('resolveDisplayBase', () => {
  let kbHome: string
  const prevHome = process.env.KB_HOME
  const prevBase = process.env.KB_BASE
  const prevActive = process.env.KB_ACTIVE_BASE

  afterEach(async () => {
    vi.unstubAllGlobals()
    if (prevHome === undefined) delete process.env.KB_HOME
    else process.env.KB_HOME = prevHome
    if (prevBase === undefined) delete process.env.KB_BASE
    else process.env.KB_BASE = prevBase
    if (prevActive === undefined) delete process.env.KB_ACTIVE_BASE
    else process.env.KB_ACTIVE_BASE = prevActive
    if (kbHome) await rm(kbHome, { recursive: true, force: true })
  })

  it('[TC-69] returns the active base (isServerDefault false) when one is selected', async () => {
    process.env.KB_BASE = 'raylib'
    // No health probe needed — the active base short-circuits before any network call.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('should not probe when an active base is set')
      }),
    )
    await expect(resolveDisplayBase({})).resolves.toEqual({
      name: 'raylib',
      isServerDefault: false,
    })
  })

  it('[TC-70] falls back to the server default (isServerDefault true) when no active base', async () => {
    kbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-display-'))
    process.env.KB_HOME = kbHome
    delete process.env.KB_BASE
    delete process.env.KB_ACTIVE_BASE
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, base: 'base' }), { status: 200 })),
    )
    await expect(resolveDisplayBase({})).resolves.toEqual({
      name: 'base',
      isServerDefault: true,
    })
  })

  it('[TC-71] reports no base (isServerDefault false) when the server is unreachable', async () => {
    kbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-display-'))
    process.env.KB_HOME = kbHome
    delete process.env.KB_BASE
    delete process.env.KB_ACTIVE_BASE
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await expect(resolveDisplayBase({})).resolves.toEqual({
      name: undefined,
      isServerDefault: false,
    })
  })
})

describe('dispatchRemoteChatStreamEvent', () => {
  it('[TC-51] routes reasoning to progress and meta to log (keeps thinking alive)', () => {
    const log = vi.fn()
    const progress = vi.fn()
    dispatchRemoteChatStreamEvent({ type: 'meta', text: 'stage> route:start' }, { log, progress })
    dispatchRemoteChatStreamEvent({ type: 'reasoning', text: 'considering Lua…' }, { log, progress })
    dispatchRemoteChatStreamEvent(
      { type: 'meta', text: 'stage> route:still-working 12s' },
      { log, progress },
    )

    expect(log.mock.calls.map(c => c[0])).toEqual([
      'stage> route:start',
      'stage> route:still-working 12s',
    ])
    expect(progress.mock.calls.map(c => c[0])).toEqual(['considering Lua…'])
  })
})

describe('CLI startup wiring', () => {
  it('[TC-28] does not auto-sync MCP or install skills from main()', () => {
    const indexPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../packages/kb-client/src/cli/index.ts'
    )
    const src = readFileSync(indexPath, 'utf8')
    const mainBody = src.slice(src.indexOf('async function main()'))
    // Opt-in only: syncKbMcpConfigs / installSkillsGlobally must not run from main().
    expect(mainBody).not.toMatch(/installSkillsGlobally\s*\(/)
    expect(mainBody).not.toMatch(/syncKbMcpConfigs\s*\(/)
  })
})
