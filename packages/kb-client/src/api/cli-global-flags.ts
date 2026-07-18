import { KB_ENV } from '@kb/core/config/kb-env.js'
import { parseKbConnectionString } from './connection-string.js'

export interface ParsedGlobalCliFlags {
  args: string[]
  host?: string
  base?: string
  connectionString?: string
}

/**
 * Strip global flags (`--host`, `--base`, `--connection-string`) before
 * subcommand dispatch.
 * - `--host` accepts `host:port`, bare hostname, or a full `http(s)://` URL.
 * - `--base` selects the server-side base by slug (sent as `X-KB-Base`).
 * - `--connection-string` accepts a `kb://apikey@host:port/base` URI.
 */
export function parseGlobalCliFlags(argv: string[]): ParsedGlobalCliFlags {
  const args: string[] = []
  let host: string | undefined
  let base: string | undefined
  let connectionString: string | undefined

  const takeValue = (
    flag: string,
    inlineValue: string | undefined,
    nextValue: string | undefined
  ): { value: string; consumedNext: boolean } => {
    if (inlineValue !== undefined) {
      const value = inlineValue.trim()
      if (!value) throw new Error(`${flag} requires a value`)
      return { value, consumedNext: false }
    }
    const value = nextValue?.trim()
    if (!value) throw new Error(`${flag} requires a value`)
    return { value, consumedNext: true }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]

    if (token === '--host' || token.startsWith('--host=')) {
      const inline = token.startsWith('--host=') ? token.slice('--host='.length) : undefined
      const { value, consumedNext } = takeValue('--host', inline, argv[i + 1])
      host = value
      if (consumedNext) i += 1
      continue
    }

    if (token === '--base' || token.startsWith('--base=')) {
      const inline = token.startsWith('--base=') ? token.slice('--base='.length) : undefined
      const { value, consumedNext } = takeValue('--base', inline, argv[i + 1])
      base = value
      if (consumedNext) i += 1
      continue
    }

    if (token === '--connection-string' || token.startsWith('--connection-string=')) {
      const inline = token.startsWith('--connection-string=')
        ? token.slice('--connection-string='.length)
        : undefined
      const { value, consumedNext } = takeValue('--connection-string', inline, argv[i + 1])
      connectionString = value
      if (consumedNext) i += 1
      continue
    }

    args.push(token)
  }

  return { args, host, base, connectionString }
}

function clearEnv(...keys: string[]): void {
  for (const key of keys) {
    // Env vars must be removed, not set to the string "undefined".
    delete process.env[key]
  }
}

/** Apply `--host` for this process (overrides env for the current kb invocation). */
export function applyHostCliOverride(hostArg: string): void {
  const trimmed = hostArg.trim()
  if (!trimmed) return

  if (trimmed.includes('://')) {
    process.env[KB_ENV.SERVER_URL] = trimmed.replace(/\/$/, '')
    clearEnv(KB_ENV.HOST, 'KBHOST', KB_ENV.PORT, 'KBPORT')
    return
  }

  if (trimmed.includes(':')) {
    const colon = trimmed.lastIndexOf(':')
    const host = trimmed.slice(0, colon).trim()
    const port = trimmed.slice(colon + 1).trim()
    if (!host || !port) throw new Error(`Invalid --host value: ${hostArg}`)
    process.env[KB_ENV.HOST] = host
    process.env[KB_ENV.PORT] = port
    clearEnv('KBHOST', 'KBPORT', KB_ENV.SERVER_URL)
    return
  }

  process.env[KB_ENV.HOST] = trimmed
  clearEnv('KBHOST', KB_ENV.SERVER_URL)
}

/** Apply `--base` for this process — selects the server-side base by slug. */
export function applyBaseCliOverride(baseArg: string): void {
  const trimmed = baseArg.trim()
  if (!trimmed) return
  process.env[KB_ENV.BASE] = trimmed
}

/**
 * Apply `--connection-string` (or `KB_CONNECTION_STRING`) for this process.
 * Expands the `kb://apikey@host:port/base` URI into the discrete env vars the
 * rest of the client already understands (`KB_SERVER_URL`, `KB_SERVER_API_KEY`,
 * `KB_BASE`).
 */
export function applyConnectionStringOverride(connectionString: string): void {
  const parsed = parseKbConnectionString(connectionString)
  process.env[KB_ENV.SERVER_URL] = parsed.url
  clearEnv(KB_ENV.HOST, 'KBHOST', KB_ENV.PORT, 'KBPORT')
  if (parsed.apiKey) process.env[KB_ENV.SERVER_API_KEY] = parsed.apiKey
  if (parsed.base) process.env[KB_ENV.BASE] = parsed.base
}

/**
 * Apply all connection-related global flags with libpq-style precedence:
 * `--connection-string` > (`--host` + `--base`) > `KB_CONNECTION_STRING` > env.
 * `--host`/`--base` refine an explicit connection string when both are given.
 */
export function applyConnectionOverrides(flags: ParsedGlobalCliFlags): void {
  const connectionString = flags.connectionString ?? process.env[KB_ENV.CONNECTION_STRING]?.trim()
  if (connectionString) applyConnectionStringOverride(connectionString)
  if (flags.host) applyHostCliOverride(flags.host)
  if (flags.base) applyBaseCliOverride(flags.base)
}
