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
    '    kb --host <host:port>',
    '    # or: export KB_HOST=<host>  export KB_PORT=<port>',
    '    # or: export KB_SERVER_URL=http://<host>:<port>',
  ]
  if (cause instanceof Error && cause.message && !cause.message.includes('fetch failed')) {
    lines.push('', `  Detail: ${cause.message}`)
  }
  return lines.join('\n')
}

/** Actionable hint shown when the server rejects a request for want of an API key. */
export function unauthorizedHint(): string {
  return [
    'unauthorized: this kb server requires an API key.',
    'Set one for the client and retry:',
    '  export KB_SERVER_API_KEY=<key>',
    '  # or add server.apiKey to your kb config',
  ].join('\n')
}

export function formatApiError(status: number, body: string): string {
  let serverError: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: string }
    serverError = parsed.error
  } catch {
    // fall through — non-JSON body
  }
  // A 401 (or an explicit `unauthorized` payload) means the client sent no key or a
  // wrong one. The bare "unauthorized" the server returns is useless to a user, so
  // replace it with an actionable hint pointing at KB_SERVER_API_KEY.
  if (status === 401 || serverError === 'unauthorized') {
    return unauthorizedHint()
  }
  if (serverError) return serverError
  return `server error (${status})`
}

export function throwConnectionError(connection: ServerConnection, cause?: unknown): never {
  throw new KbConnectionError(formatConnectionError(connection, cause), formatServerAddress(connection))
}
