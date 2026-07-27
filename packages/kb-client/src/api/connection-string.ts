import { DEFAULT_KB_SERVER_PORT } from '@kb/core/config/kb-server-port.js'

/**
 * A parsed `kb://` connection string, modelled on the libpq URI
 * (`postgresql://user:password@host:port/dbname?param=value`).
 *
 *   kb://[apikey@]host[:port]/[base][?sslmode=require|prefer|disable]
 *
 * - **apikey** lives in the userinfo slot (libpq's `PGPASSWORD`), never in
 *   `host:port` — that slot is always the port. Maps to `KB_SERVER_API_KEY`.
 * - **base** is the path segment (libpq's `dbname`); omitted ⇒ server default.
 * - **TLS** is chosen by `sslmode` (default `prefer`: TLS for remote hosts,
 *   plaintext for loopback), not by the scheme — so there is a single `kb://`.
 */
export type SslMode = 'require' | 'prefer' | 'disable'

export interface ParsedConnectionString {
  /** Resolved base URL without trailing slash, e.g. `http://localhost:38117`. Convenience/display only. */
  url: string
  hostname: string
  /** Explicit port only — omitted means "apply the scheme's default." */
  port?: string
  sslmode: SslMode
  /** API key from the userinfo slot, when present. */
  apiKey?: string
  /** Base slug from the path segment, when present. */
  base?: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** TLS for remote hosts, plaintext for loopback, under the default `sslmode=prefer`. */
export function isSecureConnection(hostname: string, sslmode: SslMode = 'prefer'): boolean {
  if (sslmode === 'require') return true
  if (sslmode === 'disable') return false
  return !LOOPBACK_HOSTS.has(hostname)
}

/**
 * Build a full base URL from decomposed host/port/sslmode — the single place that
 * decides scheme and default port, shared by `--host` and `kb://` resolution so the
 * two can never disagree.
 */
export function buildServerUrl(hostname: string, explicitPort: string | undefined, sslmode: SslMode = 'prefer'): string {
  const secure = isSecureConnection(hostname, sslmode)
  const scheme = secure ? 'https' : 'http'
  // Keep an explicit port when given. Otherwise default: plaintext falls back to
  // the KB server port; TLS uses the implicit 443.
  const port = explicitPort || (secure ? '' : String(DEFAULT_KB_SERVER_PORT))
  const authority = port ? `${hostname}:${port}` : hostname
  return `${scheme}://${authority}`
}

function parseSslMode(raw: string, sourceForError: string): SslMode {
  const sslmode = raw.toLowerCase()
  if (sslmode === 'require' || sslmode === 'prefer' || sslmode === 'disable') return sslmode
  throw new Error(`Invalid sslmode "${sslmode}" (use require, prefer, or disable): ${sourceForError}`)
}

/**
 * Parse a `kb://…` connection string into its decomposed connection parts.
 * Throws on a non-`kb://` scheme or a missing host.
 */
export function parseKbConnectionString(raw: string): ParsedConnectionString {
  const trimmed = raw.trim()
  const schemeMatch = /^kb:\/\//i.exec(trimmed)
  if (!schemeMatch) {
    throw new Error(`Invalid connection string (expected kb://host[:port]/base): ${raw}`)
  }

  // Reuse the URL parser by swapping the scheme; `http://` gives us userinfo,
  // host, port, path, and query handling for free.
  let parsed: URL
  try {
    parsed = new URL(`http://${trimmed.slice(schemeMatch[0].length)}`)
  } catch {
    throw new Error(`Invalid connection string (expected kb://host[:port]/base): ${raw}`)
  }

  const hostname = parsed.hostname
  if (!hostname) {
    throw new Error(`Invalid connection string (missing host): ${raw}`)
  }

  // Credential lives in userinfo. Accept `apikey@host` (username slot) or
  // `user:apikey@host` (password slot, like PGPASSWORD) — password wins.
  const apiKey =
    decodeURIComponent(parsed.password || parsed.username || '').trim() || undefined

  const base = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).trim() || undefined

  const sslmode = parseSslMode(parsed.searchParams.get('sslmode') || 'prefer', raw)
  const port = parsed.port || undefined
  const url = buildServerUrl(hostname, port, sslmode)

  return {
    url,
    hostname,
    sslmode,
    ...(port ? { port } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(base ? { base } : {}),
  }
}
