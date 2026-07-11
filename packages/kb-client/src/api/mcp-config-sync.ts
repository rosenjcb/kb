/**
 * Keep agent MCP client configs pointed at an **explicit** kb-server host
 * (local or remote). Never invent localhost when the operator has not set a
 * connection profile.
 *
 * Host sources (same as CLI): `--host` / `KB_SERVER_URL` / `KB_HOST`+`KB_PORT`
 * / `config.server.host` + `KB_SERVER_API_KEY` / `config.server.apiKey`.
 *
 * Targets (user scope):
 * - Cursor: `~/.cursor/mcp.json`
 * - Claude Code: `~/.claude.json` top-level `mcpServers`
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { KB_ENV, readEnvHost } from '@kb/core/config/kb-env.js'
import { isLocalMode, resolveServerConnection } from '../api/server-connection.js'
import { applyHostCliOverride } from './cli-global-flags.js'

export const KB_MCP_SERVER_NAME = 'kb'

export type McpSyncAction =
  | 'installed'
  | 'updated'
  | 'skipped'
  | 'removed'
  | 'not-found'
  | 'needs-host'

export interface McpSyncResult {
  agent: 'cursor' | 'claude' | 'all'
  action: McpSyncAction
  url?: string
  detail?: string
}

export interface SyncKbMcpOptions {
  /** Override host for this sync (`host:port`, hostname, or full URL). */
  host?: string
  /**
   * When true (default), refuse to write configs unless `host` is passed or
   * `KB_SERVER_URL` / `KB_HOST` is set in the environment. Prevents silent
   * localhost defaults from hijacking agent MCP.
   */
  requireExplicitHost?: boolean
  config?: KbConfig
}

type JsonObject = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * True when the operator chose a server (env or `config.server.host`) —
 * not the implicit localhost default from `resolveServerConnection`.
 */
export function hasExplicitServerHost(config?: KbConfig): boolean {
  if (process.env[KB_ENV.SERVER_URL]?.trim()) return true
  if (readEnvHost()) return true
  if (config?.server?.host?.trim()) return true
  return false
}

/** `${serverUrl}/mcp` with no trailing slash on the server root. */
export function resolveMcpEndpointUrl(serverUrl: string): string {
  const root = serverUrl.trim().replace(/\/$/, '')
  return `${root}/mcp`
}

export function buildCursorKbMcpEntry(mcpUrl: string, apiKey?: string): JsonObject {
  const entry: JsonObject = { url: mcpUrl }
  if (apiKey) {
    entry.headers = { Authorization: `Bearer ${apiKey}` }
  }
  return entry
}

/** Claude Code HTTP transport requires `type: "http"` (url-only is treated as stdio). */
export function buildClaudeKbMcpEntry(mcpUrl: string, apiKey?: string): JsonObject {
  const entry: JsonObject = {
    type: 'http',
    url: mcpUrl,
  }
  if (apiKey) {
    entry.headers = { Authorization: `Bearer ${apiKey}` }
  }
  return entry
}

function mcpEntryMatches(
  existing: unknown,
  expected: JsonObject,
  requireType?: boolean
): boolean {
  if (!isPlainObject(existing)) return false
  if (existing.url !== expected.url) return false
  if (requireType && existing.type !== expected.type) return false

  const expectedHeaders = expected.headers
  if (expectedHeaders === undefined) {
    // No key configured — treat a leftover Authorization as stale so sync clears it.
    if (!isPlainObject(existing.headers)) return true
    return existing.headers.Authorization === undefined
  }
  if (!isPlainObject(existing.headers)) return false
  return existing.headers.Authorization === (expectedHeaders as JsonObject).Authorization
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeJsonObject(filePath: string, value: JsonObject): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function cursorMcpPath(home = os.homedir()): string {
  return path.join(home, '.cursor', 'mcp.json')
}

export function claudeConfigPath(home = os.homedir()): string {
  return path.join(home, '.claude.json')
}

async function upsertKbMcpEntry(opts: {
  filePath: string
  expected: JsonObject
  requireType?: boolean
  agent: 'cursor' | 'claude'
  mcpUrl: string
}): Promise<McpSyncResult> {
  const doc = await readJsonObject(opts.filePath)
  const servers = isPlainObject(doc.mcpServers) ? { ...doc.mcpServers } : {}
  const existing = servers[KB_MCP_SERVER_NAME]
  const hadEntry = existing !== undefined

  if (mcpEntryMatches(existing, opts.expected, opts.requireType)) {
    return { agent: opts.agent, action: 'skipped', url: opts.mcpUrl }
  }

  servers[KB_MCP_SERVER_NAME] = opts.expected
  await writeJsonObject(opts.filePath, { ...doc, mcpServers: servers })
  return {
    agent: opts.agent,
    action: hadEntry ? 'updated' : 'installed',
    url: opts.mcpUrl,
  }
}

async function removeKbMcpEntry(
  filePath: string,
  agent: 'cursor' | 'claude'
): Promise<McpSyncResult> {
  let doc: JsonObject
  try {
    doc = await readJsonObject(filePath)
  } catch {
    return { agent, action: 'not-found' }
  }

  if (!isPlainObject(doc.mcpServers) || !(KB_MCP_SERVER_NAME in doc.mcpServers)) {
    return { agent, action: 'not-found' }
  }

  const servers = { ...doc.mcpServers }
  delete servers[KB_MCP_SERVER_NAME]
  await writeJsonObject(filePath, { ...doc, mcpServers: servers })
  return { agent, action: 'removed' }
}

function needsHostResult(): McpSyncResult[] {
  return [
    {
      agent: 'all',
      action: 'needs-host',
      detail:
        'Set KB_SERVER_URL or KB_HOST, or pass --host <host[:port]|url> (local or remote). Refusing to default MCP to localhost.',
    },
  ]
}

/**
 * Rewrite Cursor + Claude `kb` MCP entries to match an explicit connection profile.
 * No-op in `KB_LOCAL_MODE`. Refuses implicit localhost unless `requireExplicitHost` is false.
 */
export async function syncKbMcpConfigs(options: SyncKbMcpOptions = {}): Promise<McpSyncResult[]> {
  if (isLocalMode()) return []

  const config = options.config ?? {}
  const requireExplicit = options.requireExplicitHost !== false
  if (options.host?.trim()) {
    applyHostCliOverride(options.host.trim())
  } else if (requireExplicit && !hasExplicitServerHost(config)) {
    return needsHostResult()
  }

  const connection = resolveServerConnection(config)
  const mcpUrl = resolveMcpEndpointUrl(connection.url)
  const apiKey = connection.apiKey

  const cursorExpected = buildCursorKbMcpEntry(mcpUrl, apiKey)
  const claudeExpected = buildClaudeKbMcpEntry(mcpUrl, apiKey)

  return Promise.all([
    upsertKbMcpEntry({
      filePath: cursorMcpPath(),
      expected: cursorExpected,
      agent: 'cursor',
      mcpUrl,
    }),
    upsertKbMcpEntry({
      filePath: claudeConfigPath(),
      expected: claudeExpected,
      requireType: true,
      agent: 'claude',
      mcpUrl,
    }),
  ])
}

/** Remove the managed `kb` MCP entries (used by `kb skills uninstall` / `kb mcp uninstall`). */
export async function uninstallKbMcpConfigs(): Promise<McpSyncResult[]> {
  return Promise.all([
    removeKbMcpEntry(cursorMcpPath(), 'cursor'),
    removeKbMcpEntry(claudeConfigPath(), 'claude'),
  ])
}

export interface McpStatusEntry {
  agent: 'cursor' | 'claude'
  path: string
  url: string | null
  present: boolean
}

/** Read current `kb` MCP URLs from agent configs (no writes). */
export async function readKbMcpStatus(): Promise<{
  explicitEnvHost: boolean
  resolvedServerUrl: string | null
  entries: McpStatusEntry[]
}> {
  const explicitEnvHost = hasExplicitServerHost()
  let resolvedServerUrl: string | null = null
  if (!isLocalMode() && explicitEnvHost) {
    resolvedServerUrl = resolveServerConnection({}).url
  }

  const readEntry = async (
    agent: 'cursor' | 'claude',
    filePath: string
  ): Promise<McpStatusEntry> => {
    const doc = await readJsonObject(filePath)
    const servers = isPlainObject(doc.mcpServers) ? doc.mcpServers : {}
    const entry = servers[KB_MCP_SERVER_NAME]
    const url =
      isPlainObject(entry) && typeof entry.url === 'string' ? entry.url : null
    return { agent, path: filePath, url, present: url !== null }
  }

  const entries = await Promise.all([
    readEntry('cursor', cursorMcpPath()),
    readEntry('claude', claudeConfigPath()),
  ])

  return { explicitEnvHost, resolvedServerUrl, entries }
}

export function formatMcpSyncReport(results: McpSyncResult[]): string {
  if (results.length === 0) return ''
  const lines: string[] = ['MCP client configs (explicit host → /mcp):']
  for (const r of results) {
    if (r.action === 'needs-host') {
      lines.push(`  ⚠ needs host  ${r.detail ?? ''}`)
      continue
    }
    const url = r.url ? ` → ${r.url}` : ''
    if (r.action === 'installed') lines.push(`  ✓ installed  kb [${r.agent}]${url}`)
    else if (r.action === 'updated') lines.push(`  ↑ updated    kb [${r.agent}]${url}`)
    else if (r.action === 'skipped') lines.push(`  • up-to-date kb [${r.agent}]${url}`)
    else if (r.action === 'removed') lines.push(`  ✓ removed    kb [${r.agent}]`)
    else lines.push(`  - not found  kb [${r.agent}]`)
  }
  return lines.join('\n')
}

export function formatMcpStatusReport(
  status: Awaited<ReturnType<typeof readKbMcpStatus>>
): string {
  const lines: string[] = ['KB MCP status:']
  lines.push(
    status.explicitEnvHost
      ? `  env host:   ${status.resolvedServerUrl ?? '(set)'}`
      : '  env host:   (unset — set KB_SERVER_URL / KB_HOST or pass --host)'
  )
  for (const e of status.entries) {
    lines.push(
      e.present
        ? `  ${e.agent.padEnd(8)} ${e.url}`
        : `  ${e.agent.padEnd(8)} (no kb entry in ${e.path})`
    )
  }
  return lines.join('\n')
}
