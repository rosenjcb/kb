import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FILESYSTEM_TOOL_DEFINITIONS,
  buildFilesystemToolsPrompt,
  dispatchFilesystemTool,
  listDirectory,
  readFile,
  searchFileContents,
} from '../../eval/tools/filesystem-tools'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'moel-fs-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── readFile ──────────────────────────────────────────────────────────────────

describe('readFile', () => {
  it('returns content and length for an existing file', async () => {
    const p = path.join(tmpDir, 'hello.txt')
    await writeFile(p, 'hello world')
    const result = readFile(p)
    expect(result.content).toBe('hello world')
    expect(result.contentLengthChars).toBe(11)
    expect(result.error).toBeUndefined()
  })

  it('returns an error for a non-existent file', () => {
    const result = readFile(path.join(tmpDir, 'no-such.txt'))
    expect(result.error).toBeDefined()
    expect(result.content).toBeUndefined()
  })

  it('reads an empty file without error', async () => {
    const p = path.join(tmpDir, 'empty.txt')
    await writeFile(p, '')
    const result = readFile(p)
    expect(result.content).toBe('')
    expect(result.contentLengthChars).toBe(0)
    expect(result.error).toBeUndefined()
  })

  it('reads multiline content correctly', async () => {
    const p = path.join(tmpDir, 'multi.txt')
    await writeFile(p, 'line1\nline2\nline3')
    const result = readFile(p)
    expect(result.content).toContain('line2')
  })
})

// ── listDirectory ─────────────────────────────────────────────────────────────

describe('listDirectory', () => {
  it('returns sorted entries for an existing directory', async () => {
    await writeFile(path.join(tmpDir, 'b.txt'), '')
    await writeFile(path.join(tmpDir, 'a.txt'), '')
    const result = listDirectory(tmpDir)
    expect(result.entries).toEqual(['a.txt', 'b.txt'])
    expect(result.error).toBeUndefined()
  })

  it('returns an empty array for an empty directory', async () => {
    const sub = path.join(tmpDir, 'empty-dir')
    await mkdir(sub)
    const result = listDirectory(sub)
    expect(result.entries).toEqual([])
  })

  it('includes subdirectory names', async () => {
    const sub = path.join(tmpDir, 'subdir')
    await mkdir(sub)
    const result = listDirectory(tmpDir)
    expect(result.entries).toContain('subdir')
  })

  it('returns an error for a non-existent path', () => {
    const result = listDirectory(path.join(tmpDir, 'no-such-dir'))
    expect(result.error).toBeDefined()
    expect(result.entries).toBeUndefined()
  })
})

// ── searchFileContents ────────────────────────────────────────────────────────

describe('searchFileContents', () => {
  it('returns matching lines for a literal pattern', async () => {
    const p = path.join(tmpDir, 'search.txt')
    await writeFile(p, 'foo bar\nbaz qux\nfoo again')
    const result = searchFileContents(p, 'foo')
    expect(result.lines).toEqual(['foo bar', 'foo again'])
  })

  it('is case-insensitive', async () => {
    const p = path.join(tmpDir, 'case.txt')
    await writeFile(p, 'Hello World\nhello lower')
    const result = searchFileContents(p, 'HELLO')
    expect(result.lines).toHaveLength(2)
  })

  it('supports regex patterns', async () => {
    const p = path.join(tmpDir, 'regex.txt')
    await writeFile(p, 'abc123\ndef456\nabc789')
    const result = searchFileContents(p, 'abc\\d+')
    expect(result.lines).toHaveLength(2)
    expect(result.lines).toContain('abc123')
  })

  it('falls back to literal match for invalid regex', async () => {
    const p = path.join(tmpDir, 'literal.txt')
    await writeFile(p, 'a[b c\nother')
    // '[b' is invalid regex — should fall back to literal match
    const result = searchFileContents(p, '[b')
    expect(result.lines).toContain('a[b c')
  })

  it('returns empty array when no lines match', async () => {
    const p = path.join(tmpDir, 'nomatch.txt')
    await writeFile(p, 'line one\nline two')
    const result = searchFileContents(p, 'xyz')
    expect(result.lines).toEqual([])
  })

  it('returns contentLengthChars', async () => {
    const content = 'hello\nworld'
    const p = path.join(tmpDir, 'len.txt')
    await writeFile(p, content)
    const result = searchFileContents(p, 'hello')
    expect(result.contentLengthChars).toBe(content.length)
  })

  it('returns an error for a non-existent file', () => {
    const result = searchFileContents(path.join(tmpDir, 'no-such.txt'), 'pattern')
    expect(result.error).toBeDefined()
  })
})

// ── dispatchFilesystemTool ────────────────────────────────────────────────────

describe('dispatchFilesystemTool', () => {
  it('dispatches read_file', async () => {
    const p = path.join(tmpDir, 'dispatch.txt')
    await writeFile(p, 'dispatched')
    const result = dispatchFilesystemTool('read_file', { path: p })
    expect(result.content).toBe('dispatched')
  })

  it('dispatches list_directory', async () => {
    await writeFile(path.join(tmpDir, 'x.ts'), '')
    const result = dispatchFilesystemTool('list_directory', { path: tmpDir })
    expect(result.entries).toContain('x.ts')
  })

  it('dispatches search_file_contents', async () => {
    const p = path.join(tmpDir, 'search-dispatch.txt')
    await writeFile(p, 'target line\nother line')
    const result = dispatchFilesystemTool('search_file_contents', { path: p, pattern: 'target' })
    expect(result.lines).toContain('target line')
  })
})

// ── FILESYSTEM_TOOL_DEFINITIONS and buildFilesystemToolsPrompt ───────────────

describe('FILESYSTEM_TOOL_DEFINITIONS', () => {
  it('has exactly three tool definitions', () => {
    expect(FILESYSTEM_TOOL_DEFINITIONS).toHaveLength(3)
  })

  it('each definition has name, description, and schema', () => {
    for (const def of FILESYSTEM_TOOL_DEFINITIONS) {
      expect(typeof def.name).toBe('string')
      expect(typeof def.description).toBe('string')
      expect(def.schema).toBeDefined()
      expect(Array.isArray(def.schema.required)).toBe(true)
    }
  })
})

describe('buildFilesystemToolsPrompt', () => {
  it('includes the repo path in the prompt', () => {
    const prompt = buildFilesystemToolsPrompt('/some/repo')
    expect(prompt).toContain('/some/repo')
  })

  it('wraps output in filesystem-tools tags', () => {
    const prompt = buildFilesystemToolsPrompt('/repo')
    expect(prompt).toMatch(/^<filesystem-tools>/)
    expect(prompt).toMatch(/<\/filesystem-tools>$/)
  })

  it('includes tool names in the JSON', () => {
    const prompt = buildFilesystemToolsPrompt('/repo')
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('list_directory')
    expect(prompt).toContain('search_file_contents')
  })
})
