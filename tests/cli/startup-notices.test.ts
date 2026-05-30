import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { FIRST_RUN_WELCOME_NOTICE } from '../../src/cli/index'
import { uninitializedBaseNotice } from '../../src/cli/cli-prerequisites'
import { globalVenvPython } from '../../src/core/fact-categories'

describe('FIRST_RUN_WELCOME_NOTICE', () => {
  it('greets the user', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('Welcome to KB')
  })

  it('lists the core commands', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb init')
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb query')
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb graph')
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('kb docs')
  })

  it('tells the user how to get help', () => {
    expect(FIRST_RUN_WELCOME_NOTICE).toContain('help')
  })
})

describe('globalVenvPython', () => {
  let originalKbHome: string | undefined

  beforeEach(() => {
    originalKbHome = process.env.KB_HOME
  })

  afterEach(() => {
    if (originalKbHome === undefined) delete process.env.KB_HOME
    else process.env.KB_HOME = originalKbHome
  })

  it('resolves under KB_HOME when set', () => {
    process.env.KB_HOME = '/tmp/custom-kb'
    expect(globalVenvPython()).toBe('/tmp/custom-kb/.kb-python/bin/python3')
  })

  it('resolves under ~/.kb by default', () => {
    delete process.env.KB_HOME
    expect(globalVenvPython()).toBe(path.join(os.homedir(), '.kb', '.kb-python', 'bin', 'python3'))
  })
})

describe('uninitializedBaseNotice', () => {
  it('names the base in the notice', () => {
    const notice = uninitializedBaseNotice('my-project')
    expect(notice).toContain('"my-project"')
  })

  it('points the user to /init', () => {
    const notice = uninitializedBaseNotice('any')
    expect(notice).toContain('/init')
  })

  it('mentions kb init as a fallback', () => {
    const notice = uninitializedBaseNotice('any')
    expect(notice).toContain('kb init')
  })
})
