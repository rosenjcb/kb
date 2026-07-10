/**
 * Keep agent MCP client configs pointed at the same kb-server as the CLI
 * connection profile (`KB_SERVER_URL` / `KB_HOST`+`KB_PORT` + `KB_SERVER_API_KEY`).
 *
 * Targets (user scope):
 * - Cursor: `~/.cursor/mcp.json`
 * - Claude Code: `~/.claude.json` top-level `mcpServers`
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { isLocalMode, resolveServerConnection } from '../api/server-connection.js'

export const KB_MCP_SERVER_NAME = 'kb'

export type McpSyncAction = 'installed' | 'updated' | 'skipped' | 'removed' | 'not-found'

export interface McpSyncResult {
  agent: 'cursor' | 'claude'
  action: McpSyncAction
  url?: string
}

type JsonObject = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    // No key configured — do not force-clear an existing header (user may have set one).
    return true
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

function cursorMcpPath(home = os.homedir()): string {
  return path.join(home, '.cursor', 'mcp.json')
}

function claudeConfigPath(home = os.homedir()): string {
  return path.join(home, '.claude.json')
}

async function upsertKbMcpEntry(opts: {
  filePath: string
  expected: JsonObject
  requireType?: boolean
  agent: McpSyncResult['agent']
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
  agent: McpSyncResult['agent']
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

/**
 * Rewrite Cursor + Claude `kb` MCP entries to match the resolved connection profile.
 * No-op in `KB_LOCAL_MODE` (no remote MCP endpoint).
 */
export async function syncKbMcpConfigs(config: KbConfig = {}): Promise<McpSyncResult[]> {
  if (isLocalMode()) return []

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

/** Remove the managed `kb` MCP entries (used by `kb skills uninstall`). */
export async function uninstallKbMcpConfigs(): Promise<McpSyncResult[]> {
  return Promise.all([
    removeKbMcpEntry(cursorMcpPath(), 'cursor'),
    removeKbMcpEntry(claudeConfigPath(), 'claude'),
  ])
}

export function formatMcpSyncReport(results: McpSyncResult[]): string {
  if (results.length === 0) return ''
  const lines: string[] = ['MCP client configs (same host as CLI):']
  for (const r of results) {
    const url = r.url ? ` → ${r.url}` : ''
    if (r.action === 'installed') lines.push(`  ✓ installed  kb [${r.agent}]${url}`)
    else if (r.action === 'updated') lines.push(`  ↑ updated    kb [${r.agent}]${url}`)
    else if (r.action === 'skipped') lines.push(`  • up-to-date kb [${r.agent}]${url}`)
    else if (r.action === 'removed') lines.push(`  ✓ removed    kb [${r.agent}]`)
    else lines.push(`  - not found  kb [${r.agent}]`)
  }
  return lines.join('\n')
}
