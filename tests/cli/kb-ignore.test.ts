import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createIgnoreMatcher,
  normalizeIgnorePatterns,
  parseIgnoreInput,
  resolveIgnoreMatcher,
} from '../../src/cli/kb-ignore'

describe('parseIgnoreInput', () => {
  it('splits on commas and newlines and trims', () => {
    expect(parseIgnoreInput('tests/, **/*.spec.ts ,\nvendor')).toEqual([
      'tests/',
      '**/*.spec.ts',
      'vendor',
    ])
  })

  it('drops empties', () => {
    expect(parseIgnoreInput(' , ,\n')).toEqual([])
  })
})

describe('normalizeIgnorePatterns', () => {
  it('trims, removes blanks, and de-duplicates preserving order', () => {
    expect(normalizeIgnorePatterns([' a ', 'b', 'a', '', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('createIgnoreMatcher', () => {
  it('matches bare names by basename at any depth', () => {
    const m = createIgnoreMatcher(['vendor'])
    expect(m.ignores('vendor', true)).toBe(true)
    expect(m.ignores('src/vendor', true)).toBe(true)
    expect(m.ignores('a/b/vendor/x.go')).toBe(true)
    expect(m.ignores('src/main.go')).toBe(false)
  })

  it('anchors patterns that contain a slash', () => {
    const m = createIgnoreMatcher(['docs/legacy'])
    expect(m.ignores('docs/legacy', true)).toBe(true)
    expect(m.ignores('docs/legacy/old.md')).toBe(true)
    // Not anchored at root → should not match a nested docs/legacy.
    expect(m.ignores('pkg/docs/legacy/old.md')).toBe(false)
  })

  it('honours a leading slash anchor', () => {
    const m = createIgnoreMatcher(['/build'])
    expect(m.ignores('build', true)).toBe(true)
    expect(m.ignores('build/out.js')).toBe(true)
    expect(m.ignores('src/build/out.js')).toBe(false)
  })

  it('trailing slash matches directories only (but still ignores their contents)', () => {
    const m = createIgnoreMatcher(['cache/'])
    expect(m.ignores('cache', true)).toBe(true)
    expect(m.ignores('cache', false)).toBe(false) // a *file* named cache is kept
    expect(m.ignores('cache/data.bin')).toBe(true) // contents are ignored
  })

  it('supports * within a segment and ** across segments', () => {
    const star = createIgnoreMatcher(['*.spec.ts'])
    expect(star.ignores('a/b/foo.spec.ts')).toBe(true)
    expect(star.ignores('foo.ts')).toBe(false)

    const globstar = createIgnoreMatcher(['src/**/__tests__'])
    expect(globstar.ignores('src/__tests__', true)).toBe(true)
    expect(globstar.ignores('src/a/b/__tests__/x.ts')).toBe(true)
    expect(globstar.ignores('lib/__tests__/x.ts')).toBe(false)
  })

  it('supports negation to re-include', () => {
    const m = createIgnoreMatcher(['docs/**', '!docs/keep.md'])
    expect(m.hasNegation).toBe(true)
    expect(m.ignores('docs/throwaway.md')).toBe(true)
    expect(m.ignores('docs/keep.md')).toBe(false)
  })

  it('skips comments and blank lines', () => {
    const m = createIgnoreMatcher(['# a comment', '', 'vendor'])
    expect(m.patterns).toEqual(['# a comment', 'vendor'])
    expect(m.ignores('vendor', true)).toBe(true)
  })

  it('an empty matcher ignores nothing', () => {
    const m = createIgnoreMatcher([])
    expect(m.hasNegation).toBe(false)
    expect(m.ignores('anything/at/all.ts')).toBe(false)
  })

  it('normalizes backslashes and leading ./ in the tested path', () => {
    const m = createIgnoreMatcher(['vendor'])
    expect(m.ignores('./a\\vendor\\x.go')).toBe(true)
  })
})

describe('resolveIgnoreMatcher', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kb-ignore-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('merges base patterns with a .kbignore file at the repo root', async () => {
    await writeFile(path.join(dir, '.kbignore'), '# repo rules\nfixtures/\n', 'utf8')
    const m = await resolveIgnoreMatcher(dir, ['vendor'])
    expect(m.ignores('vendor', true)).toBe(true)
    expect(m.ignores('fixtures/data.json')).toBe(true)
  })

  it('works with no .kbignore present', async () => {
    const m = await resolveIgnoreMatcher(dir, ['vendor'])
    expect(m.ignores('vendor', true)).toBe(true)
    expect(m.ignores('src/main.ts')).toBe(false)
  })
})
