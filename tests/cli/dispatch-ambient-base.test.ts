import { describe, expect, it } from 'vitest'
import { applyAmbientBase } from '@kb/core/cli/dispatch.js'

/**
 * The bug these guard: the `kb` client treats `--base` as a global flag, strips it from
 * argv, and sends it as the `X-KB-Base` header. `/v1/admin/cli` ignored that header, so
 * every admin command resolved its base from `~/.kb/state/default-base` instead — and
 * `facts list --base other-suite` silently answered with the default base's data. The
 * route now threads the request's base back into argv.
 */
describe('applyAmbientBase', () => {
  it('[TC-45] injects the request base when argv carries none', () => {
    expect(applyAmbientBase(['facts', 'list'], 'eval-kestra')).toEqual([
      'facts',
      'list',
      '--base',
      'eval-kestra',
    ])
  })

  it('[TC-46] never overrides an explicit --base in argv', () => {
    expect(applyAmbientBase(['facts', 'list', '--base', 'eval-kestra'], 'eval-kb')).toEqual([
      'facts',
      'list',
      '--base',
      'eval-kestra',
    ])
  })

  it('[TC-47] is a no-op when the caller selected no base', () => {
    expect(applyAmbientBase(['facts', 'list'], undefined)).toEqual(['facts', 'list'])
  })

  it('[TC-48] leaves commands that do not take --base alone', () => {
    // `base list` has no base of its own, and injecting a flag it rejects would break it.
    expect(applyAmbientBase(['base', 'list'], 'eval-kb')).toEqual(['base', 'list'])
    expect(applyAmbientBase([], 'eval-kb')).toEqual([])
  })

  it('[TC-49] scopes every base-aware command', () => {
    for (const command of ['facts', 'graph', 'entities', 'logs', 'scan']) {
      expect(applyAmbientBase([command, 'list'], 'eval-kestra')).toContain('--base')
    }
  })
})
