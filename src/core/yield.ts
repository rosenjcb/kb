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
