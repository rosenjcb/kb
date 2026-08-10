import { describe, expect, it } from 'vitest'
import { FIRST_RUN_WELCOME_NOTICE } from '@kb/client/cli/index.js'
import { uninitializedBaseNotice } from '@kb/core/config/cli-prerequisites.js'

describe('FIRST_RUN_WELCOME_NOTICE', () => {
  it('[TC-386] greets the user', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('Welcome to KB')
  })

  it('[TC-387] lists the core commands', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb query')
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb graph')
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb facts')
  })

  it('[TC-388] tells the user how to get help', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('help')
  })

  it('[TC-389] is a non-empty string', () => {
    expect(typeof FIRST_RUN_WELCOME_NOTICE).toBe('string')
    expect(FIRST_RUN_WELCOME_NOTICE.length).toBeGreaterThan(0)
  })
})

describe('uninitializedBaseNotice', () => {
  it('[TC-390] names the base in the notice', () => {
    expect(uninitializedBaseNotice('my-project')).toContain('"my-project"')
  })

  it('[TC-391] points the user to server-managed indexing', () => {
    expect(uninitializedBaseNotice('any')).toContain('KB_GIT_REPOS')
  })

  it('[TC-392] suggests switching base via kb base use', () => {
    expect(uninitializedBaseNotice('any')).toContain('kb base use')
  })

  it('[TC-393] reflects the given base name exactly', () => {
    const notice = uninitializedBaseNotice('special-base-99')
    expect(notice).toContain('"special-base-99"')
  })
})
