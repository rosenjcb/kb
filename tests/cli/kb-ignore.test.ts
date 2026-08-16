import { describe, expect, it } from 'vitest'
import {
  createIgnoreMatcher,
  normalizeIgnorePatterns,
  parseIgnoreInput,
  readIgnorePatternsFromEnv,
} from '@kb/core/config/kb-ignore.js'

describe('parseIgnoreInput', () => {
  it('[TC-YKLS] splits on commas and newlines and trims', () => {
    expect(parseIgnoreInput('tests/, **/*.spec.ts ,\nvendor')).toEqual([
      'tests/',
      '**/*.spec.ts',
      'vendor',
    ])
  })

  it('[TC-8974] drops empties', () => {
    expect(parseIgnoreInput(' , ,\n')).toEqual([])
  })
})

describe('normalizeIgnorePatterns', () => {
  it('[TC-CW5F] trims, removes blanks, and de-duplicates preserving order', () => {
    expect(normalizeIgnorePatterns([' a ', 'b', 'a', '', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('createIgnoreMatcher', () => {
  it('[TC-RLP3] matches bare names by basename at any depth', () => {
    const m = createIgnoreMatcher(['vendor'])
    expect(m.ignores('vendor', true)).toBe(true)
    expect(m.ignores('src/vendor', true)).toBe(true)
    expect(m.ignores('a/b/vendor/x.go')).toBe(true)
    expect(m.ignores('src/main.go')).toBe(false)
  })

  it('[TC-CGCH] anchors patterns that contain a slash', () => {
    const m = createIgnoreMatcher(['docs/legacy'])
    expect(m.ignores('docs/legacy', true)).toBe(true)
    expect(m.ignores('docs/legacy/old.md')).toBe(true)
    // Not anchored at root → should not match a nested docs/legacy.
    expect(m.ignores('pkg/docs/legacy/old.md')).toBe(false)
  })

  it('[TC-23SQ] honours a leading slash anchor', () => {
    const m = createIgnoreMatcher(['/build'])
    expect(m.ignores('build', true)).toBe(true)
    expect(m.ignores('build/out.js')).toBe(true)
    expect(m.ignores('src/build/out.js')).toBe(false)
  })

  it('[TC-XXFU] trailing slash matches directories only (but still ignores their contents)', () => {
    const m = createIgnoreMatcher(['cache/'])
    expect(m.ignores('cache', true)).toBe(true)
    expect(m.ignores('cache', false)).toBe(false) // a *file* named cache is kept
    expect(m.ignores('cache/data.bin')).toBe(true) // contents are ignored
  })

  it('[TC-J1ZX] supports * within a segment and ** across segments', () => {
    const star = createIgnoreMatcher(['*.spec.ts'])
    expect(star.ignores('a/b/foo.spec.ts')).toBe(true)
    expect(star.ignores('foo.ts')).toBe(false)

    const globstar = createIgnoreMatcher(['src/**/__tests__'])
    expect(globstar.ignores('src/__tests__', true)).toBe(true)
    expect(globstar.ignores('src/a/b/__tests__/x.ts')).toBe(true)
    expect(globstar.ignores('lib/__tests__/x.ts')).toBe(false)
  })

  it('[TC-ASZ5] supports negation to re-include', () => {
    const m = createIgnoreMatcher(['docs/**', '!docs/keep.md'])
    expect(m.hasNegation).toBe(true)
    expect(m.ignores('docs/throwaway.md')).toBe(true)
    expect(m.ignores('docs/keep.md')).toBe(false)
  })

  it('[TC-JAOO] skips comments and blank lines', () => {
    const m = createIgnoreMatcher(['# a comment', '', 'vendor'])
    expect(m.patterns).toEqual(['# a comment', 'vendor'])
    expect(m.ignores('vendor', true)).toBe(true)
  })

  it('[TC-E3LJ] an empty matcher ignores nothing', () => {
    const m = createIgnoreMatcher([])
    expect(m.hasNegation).toBe(false)
    expect(m.ignores('anything/at/all.ts')).toBe(false)
  })

  it('[TC-X1KF] normalizes backslashes and leading ./ in the tested path', () => {
    const m = createIgnoreMatcher(['vendor'])
    expect(m.ignores('./a\\vendor\\x.go')).toBe(true)
  })
})

describe('readIgnorePatternsFromEnv', () => {
  it('[TC-0IEO] parses KB_SERVER_IGNORE (comma/newline separated) into patterns', () => {
    const patterns = readIgnorePatternsFromEnv({
      KB_SERVER_IGNORE: 'tests/, **/*.spec.ts\nvendor',
    } as NodeJS.ProcessEnv)
    expect(patterns).toEqual(['tests/', '**/*.spec.ts', 'vendor'])
  })

  it('[TC-2MJJ] returns [] when KB_SERVER_IGNORE is unset or empty', () => {
    expect(readIgnorePatternsFromEnv({} as NodeJS.ProcessEnv)).toEqual([])
    expect(readIgnorePatternsFromEnv({ KB_SERVER_IGNORE: '' } as NodeJS.ProcessEnv)).toEqual([])
  })
})
