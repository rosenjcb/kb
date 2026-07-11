import { readFileSync } from 'node:fs'

/**
 * Internal `@kb/core` package version.
 *
 * Not a user-facing product version — do not print in CLI/TUI banners,
 * `kb-server` start lines, MCP server metadata, or `/healthz`. Use
 * `@kb/client` / `@kb/server` versions on those surfaces. Kept for snapshot
 * manifest provenance (`producer.coreVersion`) and monorepo package.json bumps.
 *
 * Replaced by esbuild's `define` at build time; tsx/dev falls through to
 * package.json below.
 */
declare const __KB_VERSION__: string | undefined

function resolveVersion(): string {
  if (typeof __KB_VERSION__ !== 'undefined') return __KB_VERSION__
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
    return pkg.version as string
  } catch {
    return '0.0.0'
  }
}

/** @internal Snapshot / package provenance only — not for user-facing logs. */
export const KB_VERSION: string = resolveVersion()
