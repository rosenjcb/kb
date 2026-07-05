import { describe, expect, it } from 'vitest'
import { FIRST_RUN_WELCOME_NOTICE } from '@kb/client/cli/index.js'
import { uninitializedBaseNotice } from '@kb/core/config/cli-prerequisites.js'

describe('FIRST_RUN_WELCOME_NOTICE', () => {
  it('[TC-465] greets the user', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('Welcome to KB')
  })

  it('[TC-466] lists the core commands', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb query')
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb graph')
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb docs')
  })

  it('[TC-467] tells the user how to get help', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('help')
  })

  it('[TC-468] is a non-empty string', () => {
    expect(typeof FIRST_RUN_WELCOME_NOTICE).toBe('string')
    expect(FIRST_RUN_WELCOME_NOTICE.length).toBeGreaterThan(0)
  })
})

describe('uninitializedBaseNotice', () => {
  it('[TC-469] names the base in the notice', () => {
    expect(uninitializedBaseNotice('my-project')).toContain('"my-project"')
  })

  it('[TC-470] points the user to server-managed indexing', () => {
    expect(uninitializedBaseNotice('any')).toContain('KB_GIT_REPOS')
  })

  it('[TC-471] suggests switching base via kb base use', () => {
    expect(uninitializedBaseNotice('any')).toContain('kb base use')
  })

  it('[TC-472] reflects the given base name exactly', () => {
    const notice = uninitializedBaseNotice('special-base-99')
    expect(notice).toContain('"special-base-99"')
  })
})
