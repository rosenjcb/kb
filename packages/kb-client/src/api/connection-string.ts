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
export interface ParsedConnectionString {
  /** Resolved base URL without trailing slash, e.g. `http://localhost:38117`. */
  url: string
  /** API key from the userinfo slot, when present. */
  apiKey?: string
  /** Base slug from the path segment, when present. */
  base?: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Parse a `kb://…` connection string into `{ url, apiKey?, base? }`.
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

  const sslmode = (parsed.searchParams.get('sslmode') || 'prefer').toLowerCase()
  const isLoopback = LOOPBACK_HOSTS.has(hostname)
  let secure: boolean
  if (sslmode === 'require') secure = true
  else if (sslmode === 'disable') secure = false
  else if (sslmode === 'prefer') secure = !isLoopback
  else throw new Error(`Invalid sslmode "${sslmode}" (use require, prefer, or disable): ${raw}`)

  const scheme = secure ? 'https' : 'http'
  // Keep an explicit port when given. Otherwise default: plaintext falls back to
  // the KB server port; TLS uses the implicit 443.
  const port = parsed.port || (secure ? '' : String(DEFAULT_KB_SERVER_PORT))
  const authority = port ? `${hostname}:${port}` : hostname
  const url = `${scheme}://${authority}`

  return { url, ...(apiKey ? { apiKey } : {}), ...(base ? { base } : {}) }
}
