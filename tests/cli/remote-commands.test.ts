import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dispatchRemoteChatStreamEvent,
  isClientLocalCommand,
  resolveDisplayBase,
} from '@kb/client/cli/remote-commands.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('isClientLocalCommand', () => {
  it('[TC-KFYC] keeps mcp/skills/uninstall/sync/base use on the client', () => {
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

  it('[TC-SD1N] still forwards server-backed commands remotely', () => {
    expect(isClientLocalCommand(['query', 'hi'])).toBe(false)
    expect(isClientLocalCommand(['base', 'list'])).toBe(false)
    expect(isClientLocalCommand(['facts', 'list'])).toBe(false)
    expect(isClientLocalCommand(['session'])).toBe(false)
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

  it('[TC-4N1R] returns the explicit base (isFallback false) when KB_BASE is set', async () => {
    process.env.KB_BASE = 'raylib'
    // Resolved entirely locally — no network call to fail if made.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('resolveDisplayBase must never probe the network')
      })
    )
    await expect(resolveDisplayBase({})).resolves.toEqual({
      name: 'raylib',
      isFallback: false,
    })
  })

  it('[TC-MQGP] falls back to the reserved "default" slug (isFallback true) when nothing is configured', async () => {
    kbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-display-'))
    process.env.KB_HOME = kbHome
    delete process.env.KB_BASE
    delete process.env.KB_ACTIVE_BASE
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('resolveDisplayBase must never probe the network')
      })
    )
    await expect(resolveDisplayBase({})).resolves.toEqual({
      name: 'default',
      isFallback: true,
    })
  })
})

describe('dispatchRemoteChatStreamEvent', () => {
  it('[TC-9QI3] routes reasoning to progress and meta to log (keeps thinking alive)', () => {
    const log = vi.fn()
    const progress = vi.fn()
    dispatchRemoteChatStreamEvent({ type: 'meta', text: 'stage> route:start' }, { log, progress })
    dispatchRemoteChatStreamEvent(
      { type: 'reasoning', text: 'considering Lua…' },
      { log, progress }
    )
    dispatchRemoteChatStreamEvent(
      { type: 'meta', text: 'stage> route:still-working 12s' },
      { log, progress }
    )

    expect(log.mock.calls.map(c => c[0])).toEqual([
      'stage> route:start',
      'stage> route:still-working 12s',
    ])
    expect(progress.mock.calls.map(c => c[0])).toEqual(['considering Lua…'])
  })

  it("[TC-4RGX] surfaces the answer event's grouped sources via onSources", () => {
    const onSources = vi.fn()
    const grouped = [
      {
        path: 'rosenjcb/kb/src/a.ts',
        repo: 'rosenjcb/kb',
        relPath: 'src/a.ts',
        label: 'rosenjcb/kb/src/a.ts',
        href: 'https://github.com/rosenjcb/kb/blob/main/src/a.ts',
        symbols: [],
        facts: [],
        factCount: 1,
      },
    ]
    dispatchRemoteChatStreamEvent(
      { type: 'answer', text: 'Hello.', sources: grouped, factsRetrieved: 1 },
      { log: vi.fn(), progress: vi.fn() },
      { onSources }
    )
    expect(onSources).toHaveBeenCalledWith(grouped)
  })

  it('[TC-ENTC] surfaces the answer event entities via onEntities', () => {
    const onEntities = vi.fn()
    dispatchRemoteChatStreamEvent(
      {
        type: 'answer',
        text: 'Hello.',
        sources: [],
        factsRetrieved: 0,
        entities: [{ kind: 'api', name: '/v1/query', role: 'scope' }],
      },
      { log: vi.fn(), progress: vi.fn() },
      { onEntities }
    )
    expect(onEntities).toHaveBeenCalledWith([{ kind: 'api', name: '/v1/query', role: 'scope' }])
  })
})

describe('CLI startup wiring', () => {
  it('[TC-B09L] does not auto-sync MCP or install skills from main()', () => {
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
