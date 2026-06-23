/**
 * Structured JSON logger for the kb server.
 *
 * Emits one JSON line per event to stdout so Docker / Cloud Logging / any log
 * aggregator can parse and index them without a sidecar.  Control verbosity
 * with the LOG_LEVEL env var (debug | info | warn | error; default: info).
 *
 * Each line has at minimum: ts (ISO-8601), level, msg.  Additional structured
 * fields are spread in so queries like `level=error`, `path=/v1/query`, or
 * `requestId=<uuid>` work out of the box in every log platform.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase()
  return raw in LEVEL_RANK ? (raw as LogLevel) : 'info'
}

let minLevel: LogLevel = resolveLevel()

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...fields }
  process.stdout.write(JSON.stringify(entry) + '\n')
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info:  (msg: string, fields?: Record<string, unknown>) => emit('info',  msg, fields),
  warn:  (msg: string, fields?: Record<string, unknown>) => emit('warn',  msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
}
