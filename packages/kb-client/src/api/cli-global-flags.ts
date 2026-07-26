import { KB_ENV } from '@kb/core/config/kb-env.js'
import { parseKbConnectionString } from './connection-string.js'

export interface ParsedGlobalCliFlags {
  args: string[]
  host?: string
  base?: string
  connectionString?: string
  port?: string
  sslmode?: string
  apiKey?: string
}

/**
 * Strip global connection flags before subcommand dispatch: `--host`, `--base`,
 * `--connection-string`, `--port`, `--sslmode`, `--api-key`/`--key`.
 * - `--host` accepts `host:port`, bare hostname, or a full `http(s)://` URL.
 * - `--base` selects the server-side base by slug (sent as `X-KB-Base`).
 * - `--connection-string` accepts a `kb://apikey@host:port/base` URI.
 * - `--port` / `--sslmode` (`require`|`prefer`|`disable`) / `--api-key` (alias
 *   `--key`) refine the host individually — same knobs `--host`/`--connection-string`
 *   already carry, for when only one needs overriding.
 */
export function parseGlobalCliFlags(argv: string[]): ParsedGlobalCliFlags {
  const args: string[] = []
  let host: string | undefined
  let base: string | undefined
  let connectionString: string | undefined
  let port: string | undefined
  let sslmode: string | undefined
  let apiKey: string | undefined

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

    if (token === '--port' || token.startsWith('--port=')) {
      const inline = token.startsWith('--port=') ? token.slice('--port='.length) : undefined
      const { value, consumedNext } = takeValue('--port', inline, argv[i + 1])
      port = value
      if (consumedNext) i += 1
      continue
    }

    if (token === '--sslmode' || token.startsWith('--sslmode=')) {
      const inline = token.startsWith('--sslmode=') ? token.slice('--sslmode='.length) : undefined
      const { value, consumedNext } = takeValue('--sslmode', inline, argv[i + 1])
      sslmode = value
      if (consumedNext) i += 1
      continue
    }

    if (
      token === '--api-key' ||
      token.startsWith('--api-key=') ||
      token === '--key' ||
      token.startsWith('--key=')
    ) {
      const isKeyAlias = token === '--key' || token.startsWith('--key=')
      const flagName = isKeyAlias ? '--key' : '--api-key'
      const prefix = isKeyAlias ? '--key=' : '--api-key='
      const inline = token.startsWith(prefix) ? token.slice(prefix.length) : undefined
      const { value, consumedNext } = takeValue(flagName, inline, argv[i + 1])
      apiKey = value
      if (consumedNext) i += 1
      continue
    }

    args.push(token)
  }

  return { args, host, base, connectionString, port, sslmode, apiKey }
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
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error(`Invalid --host value: ${hostArg}`)
    }
    if (!parsed.hostname) throw new Error(`Invalid --host value: ${hostArg}`)
    process.env[KB_ENV.HOST] = parsed.hostname
    if (parsed.port) process.env[KB_ENV.PORT] = parsed.port
    else clearEnv(KB_ENV.PORT)
    // Explicit scheme is authoritative — force sslmode rather than letting
    // the loopback/`prefer` default decide.
    process.env[KB_ENV.SSLMODE] = parsed.protocol === 'https:' ? 'require' : 'disable'
    return
  }

  if (trimmed.includes(':')) {
    const colon = trimmed.lastIndexOf(':')
    const host = trimmed.slice(0, colon).trim()
    const port = trimmed.slice(colon + 1).trim()
    if (!host || !port) throw new Error(`Invalid --host value: ${hostArg}`)
    process.env[KB_ENV.HOST] = host
    process.env[KB_ENV.PORT] = port
    return
  }

  process.env[KB_ENV.HOST] = trimmed
}

/** Apply `--base` for this process — selects the server-side base by slug. */
export function applyBaseCliOverride(baseArg: string): void {
  const trimmed = baseArg.trim()
  if (!trimmed) return
  process.env[KB_ENV.BASE] = trimmed
}

/** Apply `--port` for this process. */
export function applyPortCliOverride(portArg: string): void {
  const trimmed = portArg.trim()
  if (!trimmed) return
  process.env[KB_ENV.PORT] = trimmed
}

/** Apply `--sslmode` (`require`|`prefer`|`disable`) for this process. */
export function applySslModeCliOverride(sslmodeArg: string): void {
  const trimmed = sslmodeArg.trim().toLowerCase()
  if (!trimmed) return
  if (trimmed !== 'require' && trimmed !== 'prefer' && trimmed !== 'disable') {
    throw new Error(`Invalid --sslmode value: ${sslmodeArg} (use require, prefer, or disable)`)
  }
  process.env[KB_ENV.SSLMODE] = trimmed
}

/** Apply `--api-key`/`--key` for this process. */
export function applyApiKeyCliOverride(apiKeyArg: string): void {
  const trimmed = apiKeyArg.trim()
  if (!trimmed) return
  process.env[KB_ENV.SERVER_API_KEY] = trimmed
}

/**
 * Apply `--connection-string` (or `KB_CONNECTION_STRING`) for this process.
 * Expands the `kb://apikey@host:port/base` URI into the discrete env vars the
 * rest of the client already understands (`KB_HOST`, `KB_PORT`, `KB_SSLMODE`,
 * `KB_SERVER_API_KEY`, `KB_BASE`).
 */
export function applyConnectionStringOverride(connectionString: string): void {
  const parsed = parseKbConnectionString(connectionString)
  process.env[KB_ENV.HOST] = parsed.hostname
  if (parsed.port) process.env[KB_ENV.PORT] = parsed.port
  else clearEnv(KB_ENV.PORT)
  process.env[KB_ENV.SSLMODE] = parsed.sslmode
  if (parsed.apiKey) process.env[KB_ENV.SERVER_API_KEY] = parsed.apiKey
  if (parsed.base) process.env[KB_ENV.BASE] = parsed.base
}

/**
 * Apply all connection-related global flags with libpq-style precedence:
 * `--connection-string` (or `KB_CONNECTION_STRING`) first, then `--host` /
 * `--port` / `--sslmode` / `--api-key` / `--base` each refine it individually
 * when also given — every canonical knob (host, port, api-key, base, sslmode,
 * connection-string) has exactly one flag and one matching env var.
 */
export function applyConnectionOverrides(flags: ParsedGlobalCliFlags): void {
  const connectionString = flags.connectionString ?? process.env[KB_ENV.CONNECTION_STRING]?.trim()
  if (connectionString) applyConnectionStringOverride(connectionString)
  if (flags.host) applyHostCliOverride(flags.host)
  if (flags.port) applyPortCliOverride(flags.port)
  if (flags.sslmode) applySslModeCliOverride(flags.sslmode)
  if (flags.apiKey) applyApiKeyCliOverride(flags.apiKey)
  if (flags.base) applyBaseCliOverride(flags.base)
}
