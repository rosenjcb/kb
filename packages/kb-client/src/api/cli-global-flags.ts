import { KB_ENV } from '@kb/core/config/kb-env.js'

export interface ParsedGlobalCliFlags {
  args: string[]
  host?: string
}

/**
 * Strip global flags (`--host`) before subcommand dispatch.
 * `--host` accepts `host:port`, bare hostname, or a full `http(s)://` URL.
 */
export function parseGlobalCliFlags(argv: string[]): ParsedGlobalCliFlags {
  const args: string[] = []
  let host: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--host') {
      const value = argv[i + 1]?.trim()
      if (!value) {
        throw new Error('--host requires a value (host:port, hostname, or URL)')
      }
      host = value
      i += 1
      continue
    }
    if (token.startsWith('--host=')) {
      const value = token.slice('--host='.length).trim()
      if (!value) throw new Error('--host requires a value')
      host = value
      continue
    }
    args.push(token)
  }

  return { args, host }
}

/** Apply `--host` for this process (overrides env for the current kb invocation). */
export function applyHostCliOverride(hostArg: string): void {
  const trimmed = hostArg.trim()
  if (!trimmed) return

  if (trimmed.includes('://')) {
    process.env[KB_ENV.SERVER_URL] = trimmed.replace(/\/$/, '')
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
    delete process.env[KB_ENV.HOST]
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
    delete process.env.KBHOST
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
    delete process.env[KB_ENV.PORT]
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
    delete process.env.KBPORT
    return
  }

  if (trimmed.includes(':')) {
    const colon = trimmed.lastIndexOf(':')
    const host = trimmed.slice(0, colon).trim()
    const port = trimmed.slice(colon + 1).trim()
    if (!host || !port) throw new Error(`Invalid --host value: ${hostArg}`)
    process.env[KB_ENV.HOST] = host
    process.env[KB_ENV.PORT] = port
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
    delete process.env.KBHOST
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
    delete process.env.KBPORT
    // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
    delete process.env[KB_ENV.SERVER_URL]
    return
  }

  process.env[KB_ENV.HOST] = trimmed
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
  delete process.env.KBHOST
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to the string "undefined"
  delete process.env[KB_ENV.SERVER_URL]
}
