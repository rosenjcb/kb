import { describe, expect, it } from 'vitest'
import { awaitRefreshThenStart } from '@kb/client/tui/base-refresh.js'

describe('awaitRefreshThenStart', () => {
  it('[TC-1] Given an async refreshBase, then startSession sees the updated value', async () => {
    const ref = { current: 'old-base-dir' }
    let capturedAtStart = ''

    await awaitRefreshThenStart(
      () => new Promise(resolve => setTimeout(() => { ref.current = 'new-base-dir'; resolve(undefined) }, 0)),
      () => { capturedAtStart = ref.current },
    )

    expect(capturedAtStart).toBe('new-base-dir')
  })

  it('[TC-2] Given refreshBase not awaited, then startSession would see stale value (regression scenario)', async () => {
    // Demonstrates what the bug looked like: fire-and-forget refresh means
    // startSession reads storageDirRef.current before it is updated.
    const ref = { current: 'old-base-dir' }
    let capturedAtStart = ''

    const refreshBase = () =>
      new Promise<void>(resolve => setTimeout(() => { ref.current = 'new-base-dir'; resolve() }, 0))
    const startSession = () => { capturedAtStart = ref.current }

    // Buggy call pattern: no await
    void refreshBase()
    startSession()

    expect(capturedAtStart).toBe('old-base-dir')
  })

  it('[TC-3] Given refreshBase rejects, then error propagates and startSession is not called', async () => {
    let sessionStarted = false

    await expect(
      awaitRefreshThenStart(
        () => Promise.reject(new Error('resolve failed')),
        () => { sessionStarted = true },
      ),
    ).rejects.toThrow('resolve failed')

    expect(sessionStarted).toBe(false)
  })
})
