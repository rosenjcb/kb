import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildClaudeKbMcpEntry,
  buildCursorKbMcpEntry,
  formatMcpSyncReport,
  resolveMcpEndpointUrl,
  syncKbMcpConfigs,
  uninstallKbMcpConfigs,
} from '@kb/client/api/mcp-config-sync.js'

let tempDir: string
let fakeHome: string
let origHome: string | undefined
let origEnv: Record<string, string | undefined>

function snapshotEnv(keys: string[]): void {
  origEnv = {}
  for (const key of keys) origEnv[key] = process.env[key]
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(origEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-mcp-sync-'))
  fakeHome = path.join(tempDir, 'home')
  await mkdir(fakeHome)
  origHome = process.env.HOME
  process.env.HOME = fakeHome
  snapshotEnv(['KB_HOST', 'KB_PORT', 'KB_SERVER_URL', 'KB_SERVER_API_KEY', 'KB_LOCAL_MODE'])
  delete process.env.KB_HOST
  delete process.env.KB_PORT
  delete process.env.KB_SERVER_URL
  delete process.env.KB_SERVER_API_KEY
  delete process.env.KB_LOCAL_MODE
})

afterEach(async () => {
  process.env.HOME = origHome
  restoreEnv()
  await rm(tempDir, { recursive: true, force: true })
})

describe('resolveMcpEndpointUrl', () => {
  it('[TC-507] appends /mcp and strips trailing slash', () => {
    expect(resolveMcpEndpointUrl('http://remote:38117/')).toBe('http://remote:38117/mcp')
    expect(resolveMcpEndpointUrl('http://remote:38117')).toBe('http://remote:38117/mcp')
  })
})

describe('build*KbMcpEntry', () => {
  it('[TC-508] Cursor entry is url + optional Bearer header', () => {
    expect(buildCursorKbMcpEntry('http://localhost:38117/mcp')).toEqual({
      url: 'http://localhost:38117/mcp',
    })
    expect(buildCursorKbMcpEntry('http://localhost:38117/mcp', 'secret')).toEqual({
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  it('[TC-509] Claude entry requires type http', () => {
    expect(buildClaudeKbMcpEntry('http://localhost:38117/mcp', 'k')).toEqual({
      type: 'http',
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer k' },
    })
  })
})

describe('syncKbMcpConfigs', () => {
  it('[TC-510] Given default host, installs kb MCP entries for Cursor and Claude', async () => {
    process.env.KB_SERVER_API_KEY = 'testkey'
    const results = await syncKbMcpConfigs()
    expect(results).toEqual([
      { agent: 'cursor', action: 'installed', url: 'http://localhost:38117/mcp' },
      { agent: 'claude', action: 'installed', url: 'http://localhost:38117/mcp' },
    ])

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb).toEqual({
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer testkey' },
    })

    const claude = JSON.parse(await readFile(path.join(fakeHome, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.kb).toEqual({
      type: 'http',
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer testkey' },
    })
  })

  it('[TC-511] Given KB_SERVER_URL, points MCP at that host /mcp', async () => {
    process.env.KB_SERVER_URL = 'https://kb.example.com:8443'
    process.env.KB_SERVER_API_KEY = 'prod'
    const results = await syncKbMcpConfigs()
    expect(results.every(r => r.url === 'https://kb.example.com:8443/mcp')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb.url).toBe('https://kb.example.com:8443/mcp')
  })

  it('[TC-512] Given matching entry, action is skipped', async () => {
    process.env.KB_SERVER_URL = 'http://remote:38117'
    process.env.KB_SERVER_API_KEY = 'k'
    await syncKbMcpConfigs()
    const second = await syncKbMcpConfigs()
    expect(second.every(r => r.action === 'skipped')).toBe(true)
  })

  it('[TC-513] Given stale URL, updates without clobbering other MCP servers', async () => {
    await mkdir(path.join(fakeHome, '.cursor'), { recursive: true })
    await writeFile(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          other: { url: 'http://other/mcp' },
          kb: { url: 'http://old:38117/mcp', headers: { Authorization: 'Bearer old' } },
        },
      }),
      'utf8'
    )
    process.env.KB_SERVER_URL = 'http://new:38117'
    process.env.KB_SERVER_API_KEY = 'newkey'
    const results = await syncKbMcpConfigs()
    const cursor = results.find(r => r.agent === 'cursor')
    expect(cursor?.action).toBe('updated')

    const doc = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(doc.mcpServers.other).toEqual({ url: 'http://other/mcp' })
    expect(doc.mcpServers.kb).toEqual({
      url: 'http://new:38117/mcp',
      headers: { Authorization: 'Bearer newkey' },
    })
  })

  it('[TC-514] Given KB_LOCAL_MODE, skips MCP sync', async () => {
    process.env.KB_LOCAL_MODE = 'true'
    const results = await syncKbMcpConfigs()
    expect(results).toEqual([])
  })
})

describe('uninstallKbMcpConfigs', () => {
  it('[TC-515] removes kb entries and leaves other servers', async () => {
    await mkdir(path.join(fakeHome, '.cursor'), { recursive: true })
    await writeFile(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          other: { url: 'http://other/mcp' },
          kb: { url: 'http://localhost:38117/mcp' },
        },
      }),
      'utf8'
    )
    await writeFile(
      path.join(fakeHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { kb: { type: 'http', url: 'http://localhost:38117/mcp' } },
        theme: 'dark',
      }),
      'utf8'
    )

    const results = await uninstallKbMcpConfigs()
    expect(results.every(r => r.action === 'removed')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb).toBeUndefined()
    expect(cursor.mcpServers.other).toEqual({ url: 'http://other/mcp' })

    const claude = JSON.parse(await readFile(path.join(fakeHome, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.kb).toBeUndefined()
    expect(claude.theme).toBe('dark')
  })

  it('[TC-516] Given no kb entry, action is not-found', async () => {
    const results = await uninstallKbMcpConfigs()
    expect(results.every(r => r.action === 'not-found')).toBe(true)
  })
})

describe('formatMcpSyncReport', () => {
  it('[TC-517] formats install/update/skip lines', () => {
    const report = formatMcpSyncReport([
      { agent: 'cursor', action: 'installed', url: 'http://localhost:38117/mcp' },
      { agent: 'claude', action: 'updated', url: 'http://remote:38117/mcp' },
    ])
    expect(report).toContain('MCP client configs')
    expect(report).toContain('installed')
    expect(report).toContain('[cursor]')
    expect(report).toContain('updated')
    expect(report).toContain('[claude]')
  })
})
