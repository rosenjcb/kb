export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve)
  })
}

export async function yieldEvery(count: number, every: number): Promise<void> {
  if (every > 0 && count > 0 && count % every === 0) {
    await yieldToEventLoop()
  }
}

/**
 * Cooperative yielder for long sync loops (SQLite / FTS / AST).
 * Yields at least every `minIntervalMs` wall-clock so HTTP (/healthz, chat)
 * can run even when each unit of work is slow (document-facts ~tens of ms/seg).
 */
export function createRateLimitedYielder(minIntervalMs = 50): () => Promise<void> {
  let lastYieldMs = 0
  return async () => {
    const now = Date.now()
    if (lastYieldMs === 0 || now - lastYieldMs >= minIntervalMs) {
      lastYieldMs = now
      await yieldToEventLoop()
    }
  }
}
