import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildClaudeKbMcpEntry,
  buildCursorKbMcpEntry,
  formatMcpStatusReport,
  formatMcpSyncReport,
  hasExplicitServerHost,
  readKbMcpStatus,
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
  snapshotEnv(['KB_HOST', 'KB_PORT', 'KB_SERVER_URL', 'KB_SERVER_API_KEY'])
  delete process.env.KB_HOST
  delete process.env.KB_PORT
  delete process.env.KB_SERVER_URL
  delete process.env.KB_SERVER_API_KEY
})

afterEach(async () => {
  process.env.HOME = origHome
  restoreEnv()
  await rm(tempDir, { recursive: true, force: true })
})

describe('resolveMcpEndpointUrl', () => {
  it('[TC-12] appends /mcp and strips trailing slash', () => {
    expect(resolveMcpEndpointUrl('http://remote:38117/')).toBe('http://remote:38117/mcp')
    expect(resolveMcpEndpointUrl('http://remote:38117')).toBe('http://remote:38117/mcp')
  })
})

describe('build*KbMcpEntry', () => {
  it('[TC-13] Cursor entry is url + optional Bearer header', () => {
    expect(buildCursorKbMcpEntry('http://localhost:38117/mcp')).toEqual({
      url: 'http://localhost:38117/mcp',
    })
    expect(buildCursorKbMcpEntry('http://localhost:38117/mcp', 'secret')).toEqual({
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  it('[TC-14] Claude entry requires type http', () => {
    expect(buildClaudeKbMcpEntry('http://localhost:38117/mcp', 'k')).toEqual({
      type: 'http',
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer k' },
    })
  })
})

describe('hasExplicitServerHost', () => {
  it('[TC-23] false when env unset; true for KB_HOST, KB_SERVER_URL, or config.server.host', () => {
    expect(hasExplicitServerHost()).toBe(false)
    process.env.KB_HOST = 'localhost'
    expect(hasExplicitServerHost()).toBe(true)
    delete process.env.KB_HOST
    process.env.KB_SERVER_URL = 'https://kb.example.com'
    expect(hasExplicitServerHost()).toBe(true)
    delete process.env.KB_SERVER_URL
    expect(hasExplicitServerHost({ server: { host: 'kb.internal' } })).toBe(true)
  })
})

describe('syncKbMcpConfigs', () => {
  it('[TC-15] Given no explicit host, defaults MCP to localhost like the CLI/TUI', async () => {
    process.env.KB_SERVER_API_KEY = 'testkey'
    const results = await syncKbMcpConfigs()
    expect(results.every(r => r.action === 'installed')).toBe(true)
    expect(results.every(r => r.url === 'http://localhost:38117/mcp')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb).toEqual({
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer testkey' },
    })
  })

  it('[TC-510b] requireExplicitHost still refuses the implicit localhost default', async () => {
    process.env.KB_SERVER_API_KEY = 'testkey'
    const results = await syncKbMcpConfigs({ requireExplicitHost: true })
    expect(results).toEqual([
      expect.objectContaining({ agent: 'all', action: 'needs-host' }),
    ])
  })

  it('[TC-16] Given KB_SERVER_URL, points MCP at that host /mcp', async () => {
    process.env.KB_SERVER_URL = 'https://kb.example.com:8443'
    process.env.KB_SERVER_API_KEY = 'prod'
    const results = await syncKbMcpConfigs()
    expect(results.every(r => r.url === 'https://kb.example.com:8443/mcp')).toBe(true)
    expect(results.every(r => r.action === 'installed')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb.url).toBe('https://kb.example.com:8443/mcp')
  })

  it('[TC-30] Given only config.server.host + apiKey, installs with Bearer', async () => {
    const results = await syncKbMcpConfigs({
      requireExplicitHost: true,
      config: { server: { host: 'kb.internal', apiKey: 'from-config' } },
    })
    expect(results.every(r => r.action === 'installed')).toBe(true)
    expect(results.every(r => r.url === 'http://kb.internal:38117/mcp')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb).toEqual({
      url: 'http://kb.internal:38117/mcp',
      headers: { Authorization: 'Bearer from-config' },
    })
  })

  it('[TC-24] Given --host override, installs even when env unset', async () => {
    process.env.KB_SERVER_API_KEY = 'testkey'
    const results = await syncKbMcpConfigs({ host: 'localhost:38117' })
    expect(results).toEqual([
      { agent: 'cursor', action: 'installed', url: 'http://localhost:38117/mcp' },
      { agent: 'claude', action: 'installed', url: 'http://localhost:38117/mcp' },
      { agent: 'antigravity', action: 'installed', url: 'http://localhost:38117/mcp' },
      { agent: 'antigravity-cli', action: 'installed', url: 'http://localhost:38117/mcp' },
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

  it('[TC-32] Given apiKey option, writes Bearer without KB_SERVER_API_KEY env', async () => {
    const results = await syncKbMcpConfigs({ host: 'https://kb.example.com', apiKey: 'from-flag' })
    expect(results.every(r => r.action === 'installed')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb).toEqual({
      url: 'https://kb.example.com/mcp',
      headers: { Authorization: 'Bearer from-flag' },
    })
    const claude = JSON.parse(await readFile(path.join(fakeHome, '.claude.json'), 'utf8'))
    expect(claude.mcpServers.kb.headers).toEqual({ Authorization: 'Bearer from-flag' })
  })

  it('[TC-33] apiKey option overrides KB_SERVER_API_KEY env', async () => {
    process.env.KB_SERVER_API_KEY = 'from-env'
    const results = await syncKbMcpConfigs({ host: 'https://kb.example.com', apiKey: 'from-flag' })
    expect(results.every(r => r.action === 'installed')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb.headers).toEqual({ Authorization: 'Bearer from-flag' })
  })

  it('[TC-17] Given matching entry, action is skipped', async () => {
    process.env.KB_SERVER_URL = 'http://remote:38117'
    process.env.KB_SERVER_API_KEY = 'k'
    await syncKbMcpConfigs()
    const second = await syncKbMcpConfigs()
    expect(second.every(r => r.action === 'skipped')).toBe(true)
  })

  it('[TC-18] Given stale URL, updates without clobbering other MCP servers', async () => {
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

  it('[TC-31] Given no API key but existing Bearer, clears Authorization', async () => {
    await mkdir(path.join(fakeHome, '.cursor'), { recursive: true })
    await writeFile(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          kb: {
            url: 'http://remote:38117/mcp',
            headers: { Authorization: 'Bearer stale' },
          },
        },
      }),
      'utf8'
    )
    process.env.KB_SERVER_URL = 'http://remote:38117'
    const results = await syncKbMcpConfigs()
    expect(results.find(r => r.agent === 'cursor')?.action).toBe('updated')

    const doc = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(doc.mcpServers.kb).toEqual({ url: 'http://remote:38117/mcp' })
    expect(doc.mcpServers.kb.headers).toBeUndefined()
  })

})

describe('uninstallKbMcpConfigs', () => {
  it('[TC-20] removes kb entries and leaves other servers', async () => {
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
    await mkdir(path.join(fakeHome, '.gemini', 'config'), { recursive: true })
    await writeFile(
      path.join(fakeHome, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: { kb: { serverUrl: 'http://localhost:38117/mcp', url: 'http://localhost:38117/mcp' } },
      }),
      'utf8'
    )
    await mkdir(path.join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(
      path.join(fakeHome, '.gemini', 'antigravity-cli', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: { kb: { serverUrl: 'http://localhost:38117/mcp', url: 'http://localhost:38117/mcp' } },
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

  it('[TC-21] Given no kb entry, action is not-found', async () => {
    const results = await uninstallKbMcpConfigs()
    expect(results.every(r => r.action === 'not-found')).toBe(true)
  })
})

describe('formatMcpSyncReport / status', () => {
  it('[TC-22] formats install/update/skip lines', () => {
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

  it('[TC-25] formats needs-host warning', () => {
    const report = formatMcpSyncReport([
      { agent: 'all', action: 'needs-host', detail: 'Set KB_SERVER_URL' },
    ])
    expect(report).toContain('needs host')
    expect(report).toContain('KB_SERVER_URL')
  })

  it('[TC-26] readKbMcpStatus reports missing entries when unset', async () => {
    const status = await readKbMcpStatus()
    expect(status.explicitEnvHost).toBe(false)
    expect(status.entries.every(e => !e.present)).toBe(true)
    const report = formatMcpStatusReport(status)
    expect(report).toContain('unset')
  })
})
