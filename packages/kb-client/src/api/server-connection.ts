import type { KbConfig } from '@kb/core/config/kb-config.js'
import type { ServerConnection } from './types.js'

const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = 8080

export function isLocalMode(): boolean {
  return process.env.KB_LOCAL_MODE === '1' || process.env.KB_LOCAL_MODE === 'true'
}

export function resolveServerConnection(config: KbConfig): ServerConnection {
  const urlOverride = process.env.KB_SERVER_URL?.trim()
  if (urlOverride) {
    return {
      url: urlOverride.replace(/\/$/, ''),
      apiKey: resolveApiKey(config),
      base: config.server?.base,
    }
  }

  const host = process.env.KBHOST?.trim() || config.server?.host?.trim() || DEFAULT_HOST
  const portRaw = process.env.KBPORT?.trim() || String(config.server?.port ?? DEFAULT_PORT)
  const port = Number.parseInt(portRaw, 10)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid KBPORT: ${portRaw}`)
  }

  const scheme = host.includes('://') ? '' : 'http://'
  const hostPart = host.includes('://') ? host : `${scheme}${host}:${port}`

  return {
    url: hostPart.replace(/\/$/, ''),
    apiKey: resolveApiKey(config),
    base: config.server?.base,
  }
}

function resolveApiKey(config: KbConfig): string | undefined {
  return process.env.KB_SERVER_API_KEY?.trim() || config.server?.apiKey?.trim() || undefined
}

export function formatServerAddress(connection: ServerConnection): string {
  try {
    const u = new URL(connection.url)
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return connection.url
  }
}
