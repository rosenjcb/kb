/**
 * In-process reindex scheduler.
 *
 * A long-lived server cannot rely on the CLI's startup-only indexing, so we
 * refresh the base on a cadence (default hourly). Each tick runs the existing
 * incremental rescan (`runScanCommand` → `git pull` + hash-diffed re-index), so
 * most ticks are cheap when nothing changed. Reads keep serving the current
 * index during a rescan (SQLite WAL allows concurrent readers).
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Parse a duration like `1h`, `30m`, `10s`, `500ms`, or a bare number of
 * milliseconds. Returns `0` for `0`/empty/unset (scheduler disabled), or
 * `undefined` when the value is malformed.
 */
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return DEFAULT_INTERVAL_MS
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '' ) return DEFAULT_INTERVAL_MS
  if (trimmed === '0') return 0

  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/)
  if (!match) return undefined
  const amount = Number.parseFloat(match[1])
  if (Number.isNaN(amount) || amount < 0) return undefined

  switch (match[2]) {
    case 'ms':
      return Math.round(amount)
    case 's':
      return Math.round(amount * 1000)
    case 'm':
      return Math.round(amount * 60 * 1000)
    case 'h':
      return Math.round(amount * 60 * 60 * 1000)
    default:
      // Bare number → milliseconds.
      return Math.round(amount)
  }
}

export interface ReindexScheduler {
  stop(): void
  /** Whether a scheduled reindex is currently executing. */
  isRunning(): boolean
}

export interface ReindexSchedulerOptions {
  intervalMs: number
  /** Runs one incremental rescan; resolves with a human summary. */
  runReindex: (onProgress?: (line: string) => void) => Promise<string>
  onLog?: (line: string) => void
}

/**
 * Start a recurring reindex timer. Overlapping ticks are skipped. The timer is
 * unref'd so it never keeps the process alive on its own. A non-positive
 * interval returns an inert scheduler (disabled).
 */
export function startReindexScheduler(options: ReindexSchedulerOptions): ReindexScheduler {
  const { intervalMs, runReindex, onLog } = options
  if (intervalMs <= 0) {
    onLog?.('[reindex] scheduler disabled (interval = 0)')
    return { stop() {}, isRunning: () => false }
  }

  let running = false

  const tick = async () => {
    if (running) {
      onLog?.('[reindex] skipped: previous run still in progress')
      return
    }
    running = true
    const startedAt = Date.now()
    try {
      const summary = await runReindex(line => onLog?.(`[reindex] ${line}`))
      onLog?.(`[reindex] ${summary} (${Date.now() - startedAt}ms)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onLog?.(`[reindex] failed: ${message}`)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  timer.unref?.()
  onLog?.(`[reindex] scheduled every ${intervalMs}ms`)

  return {
    stop() {
      clearInterval(timer)
    },
    isRunning: () => running,
  }
}
