/**
 * Keep agent MCP client configs pointed at the same kb-server the CLI/TUI uses.
 *
 * Host sources (same as CLI): `--host` / `KB_HOST`+`KB_PORT` / `KB_CONNECTION_STRING`
 * / `config.server.host`, falling back to `localhost` (same as
 * `resolveServerConnection`). Bearer from `KB_SERVER_API_KEY` /
 * `config.server.apiKey`.
 *
 * Targets (user scope):
 * - Cursor: `~/.cursor/mcp.json`
 * - Claude Code: `~/.claude.json` top-level `mcpServers`
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import {
  hasExplicitConnectionOverride,
  resolveActiveBaseName,
  resolveServerConnection,
} from '../api/server-connection.js'
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
  agent: 'cursor' | 'claude' | 'antigravity' | 'antigravity-cli' | 'all'
  action: McpSyncAction
  url?: string
  detail?: string
}

export interface SyncKbMcpOptions {
  /** Override host for this sync (`host:port`, hostname, or full URL). */
  host?: string
  /**
   * When true, refuse to write configs unless `host` is passed or
   * `KB_HOST` / `KB_CONNECTION_STRING` / `config.server.host` is set. Default
   * is false — MCP install follows `resolveServerConnection` (localhost when
   * unset), matching the CLI/TUI connection banner.
   */
  requireExplicitHost?: boolean
  /**
   * API key for the Bearer header. Overrides `KB_SERVER_API_KEY` /
   * `config.server.apiKey` for this sync, so `kb mcp install --key <key>`
   * can write the auth header without exporting the env var first.
   */
  apiKey?: string
  /**
   * Base slug written as `X-KB-Base` on the MCP entry. Defaults to
   * `resolveActiveBaseName` (same resolution as the CLI), so agents pin the
   * same base the operator has selected rather than the server boot default.
   */
  base?: string
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
  return hasExplicitConnectionOverride(config ?? {})
}

/** `${serverUrl}/mcp` with no trailing slash on the server root. */
export function resolveMcpEndpointUrl(serverUrl: string): string {
  const root = serverUrl.trim().replace(/\/$/, '')
  return `${root}/mcp`
}

/** Build the optional headers object (Bearer + X-KB-Base). Omits `headers` when empty. */
function buildMcpHeaders(apiKey?: string, base?: string): JsonObject | undefined {
  const headers: JsonObject = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const trimmedBase = base?.trim()
  if (trimmedBase) headers['X-KB-Base'] = trimmedBase
  return Object.keys(headers).length > 0 ? headers : undefined
}

export function buildCursorKbMcpEntry(mcpUrl: string, apiKey?: string, base?: string): JsonObject {
  const entry: JsonObject = { url: mcpUrl }
  const headers = buildMcpHeaders(apiKey, base)
  if (headers) entry.headers = headers
  return entry
}

/** Claude Code HTTP transport requires `type: "http"` (url-only is treated as stdio). */
export function buildClaudeKbMcpEntry(mcpUrl: string, apiKey?: string, base?: string): JsonObject {
  const entry: JsonObject = {
    type: 'http',
    url: mcpUrl,
  }
  const headers = buildMcpHeaders(apiKey, base)
  if (headers) entry.headers = headers
  return entry
}

/** Antigravity uses serverUrl key for HTTP/SSE MCP connections. */
export function buildAntigravityKbMcpEntry(
  mcpUrl: string,
  apiKey?: string,
  base?: string
): JsonObject {
  const entry: JsonObject = {
    serverUrl: mcpUrl,
    url: mcpUrl,
  }
  const headers = buildMcpHeaders(apiKey, base)
  if (headers) entry.headers = headers
  return entry
}

function mcpHeadersMatch(existing: unknown, expected: unknown): boolean {
  if (expected === undefined) {
    // No headers expected — leftover Authorization or X-KB-Base is stale.
    if (!isPlainObject(existing)) return true
    return existing.Authorization === undefined && existing['X-KB-Base'] === undefined
  }
  if (!isPlainObject(existing) || !isPlainObject(expected)) return false
  return (
    existing.Authorization === expected.Authorization &&
    existing['X-KB-Base'] === expected['X-KB-Base']
  )
}

function mcpEntryMatches(
  existing: unknown,
  expected: JsonObject,
  requireType?: boolean
): boolean {
  if (!isPlainObject(existing)) return false
  if (expected.serverUrl !== undefined && existing.serverUrl !== expected.serverUrl) return false
  if (expected.url !== undefined && existing.url !== expected.url) return false
  if (requireType && existing.type !== expected.type) return false
  return mcpHeadersMatch(existing.headers, expected.headers)
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

export function antigravityMcpConfigPath(home = os.homedir()): string {
  return path.join(home, '.gemini', 'config', 'mcp_config.json')
}

export function antigravityCliMcpConfigPath(home = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json')
}

async function upsertKbMcpEntry(opts: {
  filePath: string
  expected: JsonObject
  requireType?: boolean
  agent: 'cursor' | 'claude' | 'antigravity' | 'antigravity-cli'
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
  agent: 'cursor' | 'claude' | 'antigravity' | 'antigravity-cli'
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
        'Set KB_HOST or KB_CONNECTION_STRING, or pass --host <host[:port]|url> (local or remote). Refusing to default MCP to localhost.',
    },
  ]
}

/**
 * Rewrite Cursor + Claude + Antigravity `kb` MCP entries to match the active
 * connection profile (`resolveServerConnection`).
 * Pass `requireExplicitHost: true` to refuse the implicit localhost default.
 */
export async function syncKbMcpConfigs(options: SyncKbMcpOptions = {}): Promise<McpSyncResult[]> {
  const config = options.config ?? {}
  if (options.host?.trim()) {
    applyHostCliOverride(options.host.trim())
  } else if (options.requireExplicitHost && !hasExplicitServerHost(config)) {
    return needsHostResult()
  }

  const connection = resolveServerConnection(config)
  const mcpUrl = resolveMcpEndpointUrl(connection.url)
  const apiKey = options.apiKey?.trim() || connection.apiKey
  // Pin the same base the CLI would send — without this, MCP sessions bind the
  // server boot base and silently answer from the wrong index (#233).
  const base = options.base?.trim() || (await resolveActiveBaseName(config))

  const cursorExpected = buildCursorKbMcpEntry(mcpUrl, apiKey, base)
  const claudeExpected = buildClaudeKbMcpEntry(mcpUrl, apiKey, base)
  const antigravityExpected = buildAntigravityKbMcpEntry(mcpUrl, apiKey, base)

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
    upsertKbMcpEntry({
      filePath: antigravityMcpConfigPath(),
      expected: antigravityExpected,
      agent: 'antigravity',
      mcpUrl,
    }),
    upsertKbMcpEntry({
      filePath: antigravityCliMcpConfigPath(),
      expected: antigravityExpected,
      agent: 'antigravity-cli',
      mcpUrl,
    }),
  ])
}

/** Remove the managed `kb` MCP entries (used by `kb skills uninstall` / `kb mcp uninstall`). */
export async function uninstallKbMcpConfigs(): Promise<McpSyncResult[]> {
  return Promise.all([
    removeKbMcpEntry(cursorMcpPath(), 'cursor'),
    removeKbMcpEntry(claudeConfigPath(), 'claude'),
    removeKbMcpEntry(antigravityMcpConfigPath(), 'antigravity'),
    removeKbMcpEntry(antigravityCliMcpConfigPath(), 'antigravity-cli'),
  ])
}

export interface McpStatusEntry {
  agent: 'cursor' | 'claude' | 'antigravity' | 'antigravity-cli'
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
  if (explicitEnvHost) {
    resolvedServerUrl = resolveServerConnection({}).url
  }

  const readEntry = async (
    agent: 'cursor' | 'claude' | 'antigravity' | 'antigravity-cli',
    filePath: string
  ): Promise<McpStatusEntry> => {
    const doc = await readJsonObject(filePath)
    const servers = isPlainObject(doc.mcpServers) ? doc.mcpServers : {}
    const entry = servers[KB_MCP_SERVER_NAME]
    const url =
      isPlainObject(entry) && typeof entry.url === 'string' ? entry.url :
      isPlainObject(entry) && typeof entry.serverUrl === 'string' ? entry.serverUrl : null
    return { agent, path: filePath, url, present: url !== null }
  }

  const entries = await Promise.all([
    readEntry('cursor', cursorMcpPath()),
    readEntry('claude', claudeConfigPath()),
    readEntry('antigravity', antigravityMcpConfigPath()),
    readEntry('antigravity-cli', antigravityCliMcpConfigPath()),
  ])

  return { explicitEnvHost, resolvedServerUrl, entries }
}

export function formatMcpSyncReport(results: McpSyncResult[]): string {
  if (results.length === 0) return ''
  const lines: string[] = ['MCP client configs (active connection → /mcp):']
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
      : '  env host:   (unset — set KB_HOST / KB_CONNECTION_STRING or pass --host)'
  )
  for (const e of status.entries) {
    lines.push(
      e.present
        ? `  ${e.agent.padEnd(16)} ${e.url}`
        : `  ${e.agent.padEnd(16)} (no kb entry in ${e.path})`
    )
  }
  return lines.join('\n')
}
