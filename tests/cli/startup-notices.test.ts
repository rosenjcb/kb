import { describe, expect, it } from 'vitest'
import { FIRST_RUN_WELCOME_NOTICE } from '../../src/cli/index'
import {
  autoInitAnnouncement,
  initCancelledNotice,
  scanCancelledNotice,
  shouldAutoInit,
  uninitializedBaseNotice,
} from '../../src/cli/cli-prerequisites'

// ---------------------------------------------------------------------------
// FIRST_RUN_WELCOME_NOTICE
// ---------------------------------------------------------------------------

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

  it('is a non-empty string', () => {
    expect(typeof FIRST_RUN_WELCOME_NOTICE).toBe('string')
    expect(FIRST_RUN_WELCOME_NOTICE.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// uninitializedBaseNotice — shown for config-selected bases without an index
// ---------------------------------------------------------------------------

describe('uninitializedBaseNotice', () => {
  it('names the base in the notice', () => {
    expect(uninitializedBaseNotice('my-project')).toContain('"my-project"')
  })

  it('points the user to /init', () => {
    expect(uninitializedBaseNotice('any')).toContain('/init')
  })

  it('mentions kb init as a terminal fallback', () => {
    expect(uninitializedBaseNotice('any')).toContain('kb init')
  })

  it('reflects the given base name exactly', () => {
    const notice = uninitializedBaseNotice('special-base-99')
    expect(notice).toContain('"special-base-99"')
  })
})

describe('initCancelledNotice', () => {
  it('reassures the user and names the base when provided', () => {
    const notice = initCancelledNotice('my-project')
    expect(notice).toContain('No problem')
    expect(notice).toContain('"my-project"')
    expect(notice).toContain('nothing was saved')
    expect(notice).toContain('/init')
    expect(notice).toContain('kb init')
  })

  it('works without a base name', () => {
    const notice = initCancelledNotice()
    expect(notice).toContain('not set up yet')
    expect(notice).toContain('/init')
  })
})

describe('scanCancelledNotice', () => {
  it('reassures the user and names the base when provided', () => {
    const notice = scanCancelledNotice('my-project')
    expect(notice).toContain('No problem')
    expect(notice).toContain('"my-project"')
    expect(notice).toContain('unchanged')
    expect(notice).toContain('/scan')
  })
})

// ---------------------------------------------------------------------------
// autoInitAnnouncement — shown when a .kb file triggers automatic init
// ---------------------------------------------------------------------------

describe('autoInitAnnouncement', () => {
  it('names the base', () => {
    expect(autoInitAnnouncement('kb')).toContain('"kb"')
  })

  it('mentions kb init --base <name> so the user knows what is running', () => {
    const msg = autoInitAnnouncement('my-repo')
    expect(msg).toContain('kb init --base my-repo')
  })

  it('mentions the .kb file as the trigger', () => {
    expect(autoInitAnnouncement('kb')).toContain('.kb')
  })

  it('reflects the given base name in the init command', () => {
    const msg = autoInitAnnouncement('cool-project')
    expect(msg).toContain('--base cool-project')
  })
})

// ---------------------------------------------------------------------------
// shouldAutoInit — decision function for the auto-init flow
// ---------------------------------------------------------------------------

describe('shouldAutoInit', () => {
  it('returns true when source is directory:.kb and there is no index', () => {
    expect(shouldAutoInit('directory:.kb', false)).toBe(true)
  })

  it('returns false when the index already exists (base is initialised)', () => {
    expect(shouldAutoInit('directory:.kb', true)).toBe(false)
  })

  it('returns false when source is config.activeBase even without an index', () => {
    expect(shouldAutoInit('config.activeBase', false)).toBe(false)
  })

  it('returns false when source is config.defaultBase even without an index', () => {
    expect(shouldAutoInit('config.defaultBase', false)).toBe(false)
  })

  it('returns false when source is config.activeBase and index exists', () => {
    expect(shouldAutoInit('config.activeBase', true)).toBe(false)
  })

  it('returns false for an unknown source', () => {
    expect(shouldAutoInit('unknown-source', false)).toBe(false)
  })
})
