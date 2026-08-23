import type { KbConfig } from '@kb/core/config/kb-config.js'
import { CLI_ERROR_NO_KB_BASE } from '@kb/core/config/cli-prerequisites.js'
import { KB_ENV, readEnvHost, readEnvPortRaw } from '@kb/core/config/kb-env.js'
import { DEFAULT_BASE_SLUG, resolveEffectiveBaseDir } from '@kb/core/storage/base-selection.js'
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

export interface ActiveBaseResolution {
  /** Base name to use — always set, never the empty/undefined case. */
  name: string
  /** True when neither `KB_BASE` nor a local active base was configured, i.e. `name` is the client's own unconfigured-fallback slug. */
  isFallback: boolean
}

/**
 * The one answer to "which base is this client acting on" — consumed by BOTH the
 * `X-KB-Base` header (what kb-server actually serves) AND every display (TUI status
 * bar, CLI banner, chat header). Because the wire and the UI read the same function,
 * they can never drift. **Always resolves to a concrete name — never omitted.**
 * Precedence:
 *   1. explicit per-invocation base — `--base` / `--connection-string` (both land in `KB_BASE`)
 *   2. active base — via `resolveEffectiveBaseDir` (also honors `KB_ACTIVE_BASE`), set by `kb base use`
 *   3. the hardcoded `default` slug
 *
 * This mirrors `libpq`'s own default: a Postgres connection has no wire-level concept
 * of an omitted database — the client always sends a `dbname`, defaulting client-side
 * to the OS username before the connection ever opens. `default` here is that same
 * kind of client-side convention, not a value discovered from the server — the server
 * has no default-base *state* to discover (see `resolveServerBaseDir` in
 * `@kb/server/server-cli.js`). It happens to always be a valid base to land on because
 * `kb-server` materializes it unconditionally.
 *
 * Only `resolveEffectiveBaseDir`'s documented "no active base selected" failure is
 * swallowed into the `default` fallback — any other error (e.g. a real I/O failure
 * reading or creating the active-base state) propagates instead of being silently
 * hidden behind an unrelated base.
 */
export async function resolveActiveBaseInfo(
  cwd: string = process.cwd()
): Promise<ActiveBaseResolution> {
  const explicit = process.env[KB_ENV.BASE]?.trim()
  if (explicit) return { name: explicit, isFallback: false }
  try {
    const { baseName } = await resolveEffectiveBaseDir(cwd)
    const trimmed = baseName?.trim()
    if (trimmed) return { name: trimmed, isFallback: false }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== CLI_ERROR_NO_KB_BASE) throw error
  }
  return { name: DEFAULT_BASE_SLUG, isFallback: true }
}

/** Thin wrapper over {@link resolveActiveBaseInfo} for wire-path callers that only need the name. */
export async function resolveActiveBaseName(
  _config: KbConfig,
  cwd: string = process.cwd()
): Promise<string> {
  return (await resolveActiveBaseInfo(cwd)).name
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
  return { ...resolveServerConnection(config), base }
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

/**
 * The one copy of the fallback-base suffix text — shared by `formatConnectionContext`
 * (CLI banner, chat header) and the TUI `StatusBar` component directly, so the two
 * surfaces can't independently drift on the wording.
 */
export const BASE_FALLBACK_SUFFIX = ' (no active base selected)'

/**
 * User-facing `host: … │ base: …` label (TUI status bar, CLI banner, chat header).
 * `isFallback` is computed locally (no network round-trip — see `resolveActiveBaseName`)
 * and set when neither `KB_BASE` nor an active base was configured, so the label makes
 * clear this is the client's own unconfigured-fallback name, not an intentional choice.
 */
export function formatConnectionContext(
  config: KbConfig,
  baseName?: string,
  opts: { isFallback?: boolean } = {}
): string {
  const name = baseName?.trim()
  const base = name ? `${name}${opts.isFallback ? BASE_FALLBACK_SUFFIX : ''}` : '(none)'
  const host = formatServerAddress(resolveServerConnection(config))
  return `host: ${host} │ base: ${base}`
}

/** Host label persisted on RunReports from the client side. */
export function resolveReportHost(config: KbConfig = {}): string {
  return formatServerAddress(resolveServerConnection(config))
}
