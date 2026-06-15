import { describe, expect, it } from 'vitest'
import {
  createIgnoreMatcher,
  parseKbFileContents,
  serializeKbFile,
} from '../../src/cli/kb-file'

describe('parseKbFileContents', () => {
  it('parses TOML with base and [ignore].patterns', () => {
    const parsed = parseKbFileContents('base = "my-proj"\n\n[ignore]\npatterns = ["*.log", "dist/"]\n')
    expect(parsed.base).toBe('my-proj')
    expect(parsed.ignore).toEqual(['*.log', 'dist/'])
  })

  it('parses an inline ignore array', () => {
    const parsed = parseKbFileContents('base = "x"\nignore = ["a", "b"]\n')
    expect(parsed.ignore).toEqual(['a', 'b'])
  })

  it('falls back to legacy plain-text base names', () => {
    const parsed = parseKbFileContents('legacy-base\n')
    expect(parsed.base).toBe('legacy-base')
    expect(parsed.ignore).toEqual([])
  })

  it('returns an empty file for blank contents', () => {
    expect(parseKbFileContents('   \n')).toEqual({ ignore: [] })
  })

  it('round-trips through serialize', () => {
    const file = { base: 'demo', ignore: ['node_modules/', '*.tmp'] }
    const parsed = parseKbFileContents(serializeKbFile(file))
    expect(parsed.base).toBe('demo')
    expect(parsed.ignore).toEqual(['node_modules/', '*.tmp'])
  })
})

describe('createIgnoreMatcher', () => {
  it('matches a bare directory name at any depth', () => {
    const match = createIgnoreMatcher(['node_modules/'])
    expect(match('node_modules/react/index.js')).toBe(true)
    expect(match('packages/app/node_modules/x.js')).toBe(true)
    expect(match('src/index.ts')).toBe(false)
  })

  it('matches an extension glob anywhere', () => {
    const match = createIgnoreMatcher(['*.log'])
    expect(match('debug.log')).toBe(true)
    expect(match('logs/nested/app.log')).toBe(true)
    expect(match('app.logger.ts')).toBe(false)
  })

  it('anchors patterns that contain a slash', () => {
    const match = createIgnoreMatcher(['/build'])
    expect(match('build/output.js')).toBe(true)
    expect(match('src/build/output.js')).toBe(false)
  })

  it('supports ** across directories', () => {
    const match = createIgnoreMatcher(['drafts/**'])
    expect(match('drafts/a/b/c.md')).toBe(true)
    expect(match('drafts/note.md')).toBe(true)
    expect(match('published/note.md')).toBe(false)
  })

  it('supports negation with later patterns winning', () => {
    const match = createIgnoreMatcher(['*.md', '!README.md'])
    expect(match('NOTES.md')).toBe(true)
    expect(match('README.md')).toBe(false)
  })

  it('never matches when there are no patterns', () => {
    const match = createIgnoreMatcher([])
    expect(match('anything.ts')).toBe(false)
  })
})
