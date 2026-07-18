import type { KbConfig } from '@kb/core/config/kb-config.js'
import { isEnvTrue } from '@kb/core/config/env-boolean.js'
import { readEnvHost, readEnvPort } from '@kb/core/config/kb-env.js'
import type { ServerConnection } from './types.js'

const DEFAULT_HOST = 'localhost'

export function isLocalMode(): boolean {
  return isEnvTrue(process.env.KB_LOCAL_MODE)
}

export function resolveServerConnection(config: KbConfig): ServerConnection {
  const urlOverride = process.env.KB_SERVER_URL?.trim()
  if (urlOverride) {
    return {
      url: urlOverride.replace(/\/$/, ''),
      apiKey: resolveApiKey(config),
      base: resolveConnectionBase(config),
    }
  }

  const host = readEnvHost() || config.server?.host?.trim() || DEFAULT_HOST
  const port = readEnvPort()

  const scheme = host.includes('://') ? '' : 'http://'
  const hostPart = host.includes('://') ? host : `${scheme}${host}:${port}`

  return {
    url: hostPart.replace(/\/$/, ''),
    apiKey: resolveApiKey(config),
    base: resolveConnectionBase(config),
  }
}

function resolveApiKey(config: KbConfig): string | undefined {
  return process.env.KB_SERVER_API_KEY?.trim() || config.server?.apiKey?.trim() || undefined
}

/**
 * The base slug carried on the wire (`X-KB-Base`). Sourced from `--base` /
 * `--connection-string` (both land in `KB_BASE`), then `KB_ACTIVE_BASE`, then
 * `config.server.base`. Undefined ⇒ the server serves its own boot/default base.
 */
function resolveConnectionBase(config: KbConfig): string | undefined {
  return (
    process.env.KB_BASE?.trim() ||
    process.env.KB_ACTIVE_BASE?.trim() ||
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
  if (isLocalMode()) return `mode: local │ base: ${base}`
  const host = formatServerAddress(resolveServerConnection(config))
  return `host: ${host} │ base: ${base}`
}

/** Host label persisted on RunReports from the client side. */
export function resolveReportHost(config: KbConfig = {}): string {
  if (isLocalMode()) return 'local'
  return formatServerAddress(resolveServerConnection(config))
}
