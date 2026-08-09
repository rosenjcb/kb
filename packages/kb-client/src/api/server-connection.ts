import type { KbConfig } from '@kb/core/config/kb-config.js'
import { KB_ENV, readEnvHost, readEnvPortRaw } from '@kb/core/config/kb-env.js'
import { resolveEffectiveBaseDir } from '@kb/core/storage/base-selection.js'
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
 * Resolve the server endpoint (URL + API key) — host/port/sslmode only, **no base**.
 * Host/port/sslmode funnel through `buildServerUrl` — the same inference `kb://`
 * connection strings use — so `--host`/`KB_HOST` and
 * `--connection-string`/`KB_CONNECTION_STRING` can never disagree on scheme or
 * default port for the same bare hostname.
 *
 * Base selection is async (it reads persisted base state) and lives in
 * `resolveActiveBaseName` — the single source of truth shared with the UI. Request
 * paths compose the two via `resolveServerConnectionWithBase`.
 */
export function resolveServerConnection(config: KbConfig): ServerConnection {
  const host = readEnvHost() || config.server?.host?.trim() || DEFAULT_HOST
  const port = readEnvPortRaw()
  const sslmode = readEnvSslMode()

  return {
    url: buildServerUrl(host, port, sslmode),
    apiKey: resolveApiKey(config),
  }
}

/**
 * The one answer to "which base is this client acting on" — consumed by BOTH the
 * `X-KB-Base` header (what kb-server actually serves) AND every display (TUI status
 * bar, CLI banner, chat header). Because the wire and the UI read the same function,
 * they can never drift. Precedence:
 *   1. explicit per-invocation base — `--base` / `--connection-string` (both land in `KB_BASE`)
 *   2. active base  ┐ via `resolveEffectiveBaseDir` (also honors `KB_ACTIVE_BASE`);
 *   3. default base ┘ set by `kb base use` / `kb base use --default`
 *   4. `config.server.base`
 * Undefined ⇒ kb-server serves its own default base.
 */
export async function resolveActiveBaseName(
  config: KbConfig,
  cwd: string = process.cwd()
): Promise<string | undefined> {
  const explicit = process.env[KB_ENV.BASE]?.trim()
  if (explicit) return explicit
  try {
    const { baseName } = await resolveEffectiveBaseDir(cwd)
    const trimmed = baseName?.trim()
    if (trimmed) return trimmed
  } catch {
    // No active / default base selected locally — fall through.
  }
  return config.server?.base?.trim() || undefined
}

/**
 * Request-path connection: the sync endpoint plus the unified base, sent as
 * `X-KB-Base`. Every path that actually talks to kb-server builds its client from
 * this, so the served base always matches what the UI shows.
 */
export async function resolveServerConnectionWithBase(
  config: KbConfig,
  cwd: string = process.cwd()
): Promise<ServerConnection> {
  const base = await resolveActiveBaseName(config, cwd)
  return { ...resolveServerConnection(config), ...(base ? { base } : {}) }
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
