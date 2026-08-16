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
import { runMainWithOutput } from '@kb/client/cli/index.js'

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
  snapshotEnv(['KB_HOST', 'KB_PORT', 'KB_SSLMODE', 'KB_CONNECTION_STRING', 'KB_SERVER_API_KEY'])
  delete process.env.KB_HOST
  delete process.env.KB_PORT
  delete process.env.KB_SSLMODE
  delete process.env.KB_SERVER_API_KEY
})

afterEach(async () => {
  process.env.HOME = origHome
  restoreEnv()
  await rm(tempDir, { recursive: true, force: true })
})

describe('resolveMcpEndpointUrl', () => {
  it('[TC-DLOM] appends /mcp and strips trailing slash', () => {
    expect(resolveMcpEndpointUrl('http://remote:38117/')).toBe('http://remote:38117/mcp')
    expect(resolveMcpEndpointUrl('http://remote:38117')).toBe('http://remote:38117/mcp')
  })
})

describe('build*KbMcpEntry', () => {
  it('[TC-J1S1] Cursor entry is url + optional Bearer header', () => {
    expect(buildCursorKbMcpEntry('http://localhost:38117/mcp')).toEqual({
      url: 'http://localhost:38117/mcp',
    })
    expect(buildCursorKbMcpEntry('http://localhost:38117/mcp', 'secret')).toEqual({
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer secret' },
    })
  })

  it('[TC-KUXM] Claude entry requires type http', () => {
    expect(buildClaudeKbMcpEntry('http://localhost:38117/mcp', 'k')).toEqual({
      type: 'http',
      url: 'http://localhost:38117/mcp',
      headers: { Authorization: 'Bearer k' },
    })
  })
})

describe('hasExplicitServerHost', () => {
  it('[TC-DDES] false when env unset; true for KB_HOST, KB_CONNECTION_STRING, or config.server.host', () => {
    expect(hasExplicitServerHost()).toBe(false)
    process.env.KB_HOST = 'localhost'
    expect(hasExplicitServerHost()).toBe(true)
    delete process.env.KB_HOST
    process.env.KB_CONNECTION_STRING = 'kb://kb.example.com'
    expect(hasExplicitServerHost()).toBe(true)
    delete process.env.KB_CONNECTION_STRING
    expect(hasExplicitServerHost({ server: { host: 'kb.internal' } })).toBe(true)
  })
})

describe('syncKbMcpConfigs', () => {
  it('[TC-SQMH] Given no explicit host, defaults MCP to localhost like the CLI/TUI', async () => {
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

  it('[TC-6ZYN] requireExplicitHost still refuses the implicit localhost default', async () => {
    process.env.KB_SERVER_API_KEY = 'testkey'
    const results = await syncKbMcpConfigs({ requireExplicitHost: true })
    expect(results).toEqual([
      expect.objectContaining({ agent: 'all', action: 'needs-host' }),
    ])
  })

  it('[TC-41V9] Given KB_HOST/KB_PORT/KB_SSLMODE, points MCP at that host /mcp', async () => {
    process.env.KB_HOST = 'kb.example.com'
    process.env.KB_PORT = '8443'
    process.env.KB_SSLMODE = 'require'
    process.env.KB_SERVER_API_KEY = 'prod'
    const results = await syncKbMcpConfigs()
    expect(results.every(r => r.url === 'https://kb.example.com:8443/mcp')).toBe(true)
    expect(results.every(r => r.action === 'installed')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb.url).toBe('https://kb.example.com:8443/mcp')
  })

  it('[TC-5W7A] Given only config.server.host + apiKey, installs with Bearer (bare non-loopback host infers https)', async () => {
    const results = await syncKbMcpConfigs({
      requireExplicitHost: true,
      config: { server: { host: 'kb.internal', apiKey: 'from-config' } },
    })
    expect(results.every(r => r.action === 'installed')).toBe(true)
    expect(results.every(r => r.url === 'https://kb.internal/mcp')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb).toEqual({
      url: 'https://kb.internal/mcp',
      headers: { Authorization: 'Bearer from-config' },
    })
  })

  it('[TC-749M] Given --host override, installs even when env unset', async () => {
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

  it('[TC-X5IO] Given apiKey option, writes Bearer without KB_SERVER_API_KEY env', async () => {
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

  it('[TC-UJ7R] apiKey option overrides KB_SERVER_API_KEY env', async () => {
    process.env.KB_SERVER_API_KEY = 'from-env'
    const results = await syncKbMcpConfigs({ host: 'https://kb.example.com', apiKey: 'from-flag' })
    expect(results.every(r => r.action === 'installed')).toBe(true)

    const cursor = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.kb.headers).toEqual({ Authorization: 'Bearer from-flag' })
  })

  it('[TC-QD7E] Given matching entry, action is skipped', async () => {
    process.env.KB_HOST = 'remote'
    process.env.KB_PORT = '38117'
    process.env.KB_SERVER_API_KEY = 'k'
    await syncKbMcpConfigs()
    const second = await syncKbMcpConfigs()
    expect(second.every(r => r.action === 'skipped')).toBe(true)
  })

  it('[TC-ZIAB] Given stale URL, updates without clobbering other MCP servers', async () => {
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
    process.env.KB_HOST = 'new'
    process.env.KB_PORT = '38117'
    process.env.KB_SSLMODE = 'disable'
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

  it('[TC-JI78] Given no API key but existing Bearer, clears Authorization', async () => {
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
    process.env.KB_HOST = 'remote'
    process.env.KB_PORT = '38117'
    process.env.KB_SSLMODE = 'disable'
    const results = await syncKbMcpConfigs()
    expect(results.find(r => r.agent === 'cursor')?.action).toBe('updated')

    const doc = JSON.parse(await readFile(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))
    expect(doc.mcpServers.kb).toEqual({ url: 'http://remote:38117/mcp' })
    expect(doc.mcpServers.kb.headers).toBeUndefined()
  })

})

describe('uninstallKbMcpConfigs', () => {
  it('[TC-XA0Q] removes kb entries and leaves other servers', async () => {
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

  it('[TC-UX51] Given no kb entry, action is not-found', async () => {
    const results = await uninstallKbMcpConfigs()
    expect(results.every(r => r.action === 'not-found')).toBe(true)
  })
})

describe('formatMcpSyncReport / status', () => {
  it('[TC-68L8] formats install/update/skip lines', () => {
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

  it('[TC-3WXS] formats needs-host warning', () => {
    const report = formatMcpSyncReport([
      { agent: 'all', action: 'needs-host', detail: 'Set KB_HOST' },
    ])
    expect(report).toContain('needs host')
    expect(report).toContain('KB_HOST')
  })

  it('[TC-O4VO] readKbMcpStatus reports missing entries when unset', async () => {
    const status = await readKbMcpStatus()
    expect(status.explicitEnvHost).toBe(false)
    expect(status.entries.every(e => !e.present)).toBe(true)
    const report = formatMcpStatusReport(status)
    expect(report).toContain('unset')
  })
})

describe('cli/index.ts mcp install dispatch (no duplicate flag parser)', () => {
  it('[TC-5PBB] Given zero extra args, mcp install syncs from the already-applied ambient connection', async () => {
    process.env.KB_HOST = 'kb.internal'
    process.env.KB_SSLMODE = 'disable'
    process.env.KB_PORT = '9000'
    process.env.KB_SERVER_API_KEY = 'testkey'
    const { out, lines } = makeOut()
    await runMainWithOutput(['mcp', 'install'], out, {} as never)
    expect(lines.join('\n')).toContain('http://kb.internal:9000/mcp')
  })

  it('[TC-HALW] Given a leftover unrecognized arg, mcp install still errors', async () => {
    const { out, lines } = makeOut()
    await runMainWithOutput(['mcp', 'install', 'bogus'], out, {} as never)
    expect(lines.join('\n')).toContain('Unknown argument: bogus')
  })
})
