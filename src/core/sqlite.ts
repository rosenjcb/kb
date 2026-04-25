import { createRequire } from 'node:module'

type Statement = {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

type DatabaseCtor = new (path: string, options?: Record<string, unknown>) => {
  prepare(sql: string): Statement
  transaction<T>(fn: () => T): () => T
  exec(sql: string): void
  pragma?(sql: string): unknown
  close(): void
}

const require = createRequire(import.meta.url)

function resolveDatabaseCtor(): DatabaseCtor {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return require('bun:sqlite').Database as DatabaseCtor
  }
  return require('better-sqlite3') as DatabaseCtor
}

const DatabaseImpl = resolveDatabaseCtor()

export default DatabaseImpl
export { DatabaseImpl as Database }
