import type { KbConfig } from '@kb/core/config/kb-config.js'
import { KB_ENV, readEnvHost, readEnvPortRaw } from '@kb/core/config/kb-env.js'
import { buildServerUrl, type SslMode } from './connection-string.js'
import type { ServerConnection } from './types.js'

const DEFAULT_HOST = 'localhost'

function readEnvSslMode(): SslMode | undefined {
  const raw = process.env[KB_ENV.SSLMODE]?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'require' || raw === 'prefer' || raw === 'disable') return raw
  throw new Error(`Invalid ${KB_ENV.SSLMODE}: ${raw} (use require, prefer, or disable)`)
}

/**
 * The one connection resolver. Host/port/sslmode funnel through `buildServerUrl` —
 * the same inference `kb://` connection strings use — so `--host`/`KB_HOST` and
 * `--connection-string`/`KB_CONNECTION_STRING` can never disagree on scheme or
 * default port for the same bare hostname.
 */
export function resolveServerConnection(config: KbConfig): ServerConnection {
  const host = readEnvHost() || config.server?.host?.trim() || DEFAULT_HOST
  const port = readEnvPortRaw()
  const sslmode = readEnvSslMode()

  return {
    url: buildServerUrl(host, port, sslmode),
    apiKey: resolveApiKey(config),
    base: resolveConnectionBase(config),
  }
}

/** True when the operator explicitly configured a connection (not the implicit localhost default). */
export function hasExplicitConnectionOverride(config: KbConfig): boolean {
  if (process.env[KB_ENV.CONNECTION_STRING]?.trim()) return true
  if (readEnvHost()) return true
  if (readEnvPortRaw()) return true
  if (process.env[KB_ENV.SSLMODE]?.trim()) return true
  if (config.server?.host?.trim()) return true
  return false
}

function resolveApiKey(config: KbConfig): string | undefined {
  return process.env[KB_ENV.SERVER_API_KEY]?.trim() || config.server?.apiKey?.trim() || undefined
}

/**
 * The base slug carried on the wire (`X-KB-Base`). Sourced from `--base` /
 * `--connection-string` (both land in `KB_BASE`), then `KB_ACTIVE_BASE`, then
 * `config.server.base`. Undefined ⇒ the server serves its own boot/default base.
 */
function resolveConnectionBase(config: KbConfig): string | undefined {
  return (
    process.env[KB_ENV.BASE]?.trim() ||
    process.env[KB_ENV.ACTIVE_BASE]?.trim() ||
    config.server?.base?.trim() ||
    undefined
  )
}

export function formatServerAddress(connection: ServerConnection): string {
  try {
    const u = new URL(connection.url)
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return connection.url
  }
}

/** User-facing `host: … │ base: …` label (TUI status bar, CLI banner, chat header). */
export function formatConnectionContext(config: KbConfig, baseName?: string): string {
  const base = baseName?.trim() || '(none)'
  const host = formatServerAddress(resolveServerConnection(config))
  return `host: ${host} │ base: ${base}`
}

/** Host label persisted on RunReports from the client side. */
export function resolveReportHost(config: KbConfig = {}): string {
  return formatServerAddress(resolveServerConnection(config))
}
