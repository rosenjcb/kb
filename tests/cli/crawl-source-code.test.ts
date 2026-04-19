import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SOURCE_CODE_EXCLUDE_DIRS,
  SOURCE_CODE_EXTENSIONS,
  SOURCE_CODE_PER_FILE_CHARS,
  crawlSourceCode,
} from '../../src/cli/init-cli'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-crawl-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('crawlSourceCode', () => {
  it('Given a directory with TypeScript files, then includes them', async () => {
    await writeFile(path.join(tempDir, 'index.ts'), 'export function hello() {}', 'utf8')
    const result = await crawlSourceCode(tempDir)
    expect(result['index.ts']).toBeDefined()
    expect(result['index.ts']).toContain('export function hello')
  })

  it('Given nested source files, then includes files from subdirectories', async () => {
    await mkdir(path.join(tempDir, 'src'))
    await writeFile(path.join(tempDir, 'src', 'utils.ts'), 'export const x = 1', 'utf8')
    const result = await crawlSourceCode(tempDir)
    expect(result['src/utils.ts']).toBeDefined()
  })

  it('Given a node_modules directory, then excludes it', async () => {
    await mkdir(path.join(tempDir, 'node_modules', 'some-pkg'), { recursive: true })
    await writeFile(path.join(tempDir, 'node_modules', 'some-pkg', 'index.ts'), 'export {}', 'utf8')
    const result = await crawlSourceCode(tempDir)
    expect(Object.keys(result).some(k => k.includes('node_modules'))).toBe(false)
  })

  it('Given all excluded dirs, then none appear in result', async () => {
    for (const dir of SOURCE_CODE_EXCLUDE_DIRS) {
      await mkdir(path.join(tempDir, dir), { recursive: true })
      await writeFile(path.join(tempDir, dir, 'file.ts'), 'export {}', 'utf8')
    }
    const result = await crawlSourceCode(tempDir)
    for (const dir of SOURCE_CODE_EXCLUDE_DIRS) {
      expect(Object.keys(result).some(k => k.startsWith(`${dir}/`))).toBe(false)
    }
  })

  it('Given a markdown file, then excludes it (not a source code extension)', async () => {
    await writeFile(path.join(tempDir, 'README.md'), '# Readme', 'utf8')
    await writeFile(path.join(tempDir, 'app.ts'), 'export {}', 'utf8')
    const result = await crawlSourceCode(tempDir)
    expect(result['README.md']).toBeUndefined()
    expect(result['app.ts']).toBeDefined()
  })

  it('Given a file longer than per-file char limit, then truncates content', async () => {
    const longContent = 'x'.repeat(SOURCE_CODE_PER_FILE_CHARS * 3)
    await writeFile(path.join(tempDir, 'big.ts'), longContent, 'utf8')
    const result = await crawlSourceCode(tempDir)
    expect(result['big.ts']).toBeDefined()
    expect(result['big.ts']?.length).toBeLessThanOrEqual(SOURCE_CODE_PER_FILE_CHARS)
  })

  it('Given an empty directory, then returns empty object', async () => {
    const result = await crawlSourceCode(tempDir)
    expect(result).toEqual({})
  })

  it('Given dotfiles/dotdirs, then skips them', async () => {
    await mkdir(path.join(tempDir, '.hidden'))
    await writeFile(path.join(tempDir, '.hidden', 'secret.ts'), 'export {}', 'utf8')
    const result = await crawlSourceCode(tempDir)
    expect(Object.keys(result).some(k => k.startsWith('.'))).toBe(false)
  })

  it('Given all supported extensions, then includes them', async () => {
    const samples: Record<string, string> = {
      'app.ts': 'const x = 1',
      'app.tsx': 'const y = 2',
      'app.js': 'const z = 3',
      'app.py': 'x = 1',
      'app.go': 'package main',
    }
    for (const [file, content] of Object.entries(samples)) {
      await writeFile(path.join(tempDir, file), content, 'utf8')
    }
    const result = await crawlSourceCode(tempDir)
    for (const file of Object.keys(samples)) {
      expect(result[file]).toBeDefined()
    }
  })

  it('SOURCE_CODE_EXTENSIONS contains expected languages', () => {
    expect(SOURCE_CODE_EXTENSIONS).toContain('.ts')
    expect(SOURCE_CODE_EXTENSIONS).toContain('.tsx')
    expect(SOURCE_CODE_EXTENSIONS).toContain('.js')
    expect(SOURCE_CODE_EXTENSIONS).toContain('.py')
    expect(SOURCE_CODE_EXTENSIONS).toContain('.go')
  })
})
