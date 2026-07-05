import type { ServerConnection } from './types.js'
import { formatServerAddress } from './server-connection.js'

export class KbConnectionError extends Error {
  constructor(
    message: string,
    readonly address: string,
  ) {
    super(message)
    this.name = 'KbConnectionError'
  }
}

export function formatConnectionError(connection: ServerConnection, cause?: unknown): string {
  const address = formatServerAddress(connection)
  const lines = [
    `kb: could not connect to server at ${address}`,
    'Is the kb server running?',
    '',
    '  Start locally:  kb-server start',
    '',
    '  Or point the client at a remote server:',
    '    export KB_HOST=<host>',
    '    export KB_PORT=<port>',
    '    # or: export KB_SERVER_URL=http://<host>:<port>',
  ]
  if (cause instanceof Error && cause.message && !cause.message.includes('fetch failed')) {
    lines.push('', `  Detail: ${cause.message}`)
  }
  return lines.join('\n')
}

export function formatApiError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string }
    if (parsed.error) return parsed.error
  } catch {
    // fall through
  }
  return `server error (${status})`
}

export function throwConnectionError(connection: ServerConnection, cause?: unknown): never {
  throw new KbConnectionError(formatConnectionError(connection, cause), formatServerAddress(connection))
}
