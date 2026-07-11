import { readFileSync } from 'node:fs'

// Replaced by esbuild's `define` at build time; package.json fallback for tsx/dev.
declare const __KB_CLIENT_VERSION__: string | undefined

/** `@kb/client` package version (build-time define, else package.json). */
export function resolveClientVersion(): string {
  if (typeof __KB_CLIENT_VERSION__ !== 'undefined') return __KB_CLIENT_VERSION__
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Convenience constant for CLI/TUI banners (`kb --version`, welcome line). */
export const CLIENT_VERSION: string = resolveClientVersion()
