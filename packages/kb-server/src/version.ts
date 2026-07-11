import { readFileSync } from 'node:fs'

// Replaced by esbuild's `define` at build time; package.json fallback for tsx/dev.
declare const __KB_SERVER_VERSION__: string | undefined

/** `@kb/server` package version (build-time define, else package.json). */
export function resolveServerVersion(): string {
  if (typeof __KB_SERVER_VERSION__ !== 'undefined') return __KB_SERVER_VERSION__
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
