import { readFileSync } from 'node:fs'

// Replaced by esbuild's `define` at build time.
// In dev mode (tsx), this falls through to the package.json read below.
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

export const KB_VERSION: string = resolveVersion()
