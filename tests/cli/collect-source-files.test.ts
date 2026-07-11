import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIgnoreMatcher } from '@kb/core/config/kb-ignore.js'
import { collectSourceFiles } from '@kb/core/ops/init-cli.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-collect-source-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('collectSourceFiles', () => {
  it('[TC-119] walks deeply nested directories without stopping early', async () => {
    // Reproduce: packages/catalog/src is 3 levels down
    await mkdir(path.join(tempDir, 'packages', 'catalog', 'src'), { recursive: true })
    await writeFile(path.join(tempDir, 'README.md'), '# Root', 'utf8')
    await writeFile(path.join(tempDir, 'packages', 'catalog', 'src', 'OVERVIEW.md'), '# Overview', 'utf8')

    const result = await collectSourceFiles(tempDir)

    expect(result['README.md']).toBeDefined()
    expect(result['packages/catalog/src/OVERVIEW.md']).toBeDefined()
  })

  it('[TC-120] collects more than 100 markdown files (no file-count cap)', async () => {
    // Previously capped at MAX_MARKDOWN_SOURCE_FILES = 100; verify that cap is gone
    const count = 110
    await mkdir(path.join(tempDir, 'docs'), { recursive: true })
    for (let i = 0; i < count; i++) {
      await writeFile(path.join(tempDir, 'docs', `doc-${i}.md`), `# Doc ${i}`, 'utf8')
    }

    const result = await collectSourceFiles(tempDir)

    expect(Object.keys(result).length).toBeGreaterThanOrEqual(count)
  })

  it('[TC-121] skips dotfile directories', async () => {
    await mkdir(path.join(tempDir, '.hidden'), { recursive: true })
    await writeFile(path.join(tempDir, '.hidden', 'secret.md'), '# Secret', 'utf8')
    await writeFile(path.join(tempDir, 'visible.md'), '# Visible', 'utf8')

    const result = await collectSourceFiles(tempDir)

    expect(Object.keys(result).some(k => k.includes('.hidden'))).toBe(false)
    expect(result['visible.md']).toBeDefined()
  })

  it('[TC-122] skips excluded directories like node_modules', async () => {
    await mkdir(path.join(tempDir, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(tempDir, 'node_modules', 'pkg', 'README.md'), '# Pkg', 'utf8')
    await writeFile(path.join(tempDir, 'README.md'), '# Root', 'utf8')

    const result = await collectSourceFiles(tempDir)

    expect(Object.keys(result).some(k => k.includes('node_modules'))).toBe(false)
    expect(result['README.md']).toBeDefined()
  })

  it('[TC-123] explores sibling directories at the same depth', async () => {
    // Verify alphabetically-later siblings are visited even when earlier ones have many files
    await mkdir(path.join(tempDir, 'aaa'), { recursive: true })
    await mkdir(path.join(tempDir, 'zzz'), { recursive: true })
    for (let i = 0; i < 50; i++) {
      await writeFile(path.join(tempDir, 'aaa', `note-${i}.md`), `# Note ${i}`, 'utf8')
    }
    await writeFile(path.join(tempDir, 'zzz', 'late.md'), '# Late', 'utf8')

    const result = await collectSourceFiles(tempDir)

    expect(result['zzz/late.md']).toBeDefined()
  })

  it('[TC-124] respects an ignore matcher (prunes dirs and files)', async () => {
    await mkdir(path.join(tempDir, 'docs', 'legacy'), { recursive: true })
    await writeFile(path.join(tempDir, 'README.md'), '# Root', 'utf8')
    await writeFile(path.join(tempDir, 'docs', 'guide.md'), '# Guide', 'utf8')
    await writeFile(path.join(tempDir, 'docs', 'legacy', 'old.md'), '# Old', 'utf8')
    await writeFile(path.join(tempDir, 'NOTES.draft.md'), '# Draft', 'utf8')

    const matcher = createIgnoreMatcher(['docs/legacy/', '*.draft.md'])
    const result = await collectSourceFiles(tempDir, undefined, matcher)

    expect(result['README.md']).toBeDefined()
    expect(result['docs/guide.md']).toBeDefined()
    expect(result['docs/legacy/old.md']).toBeUndefined()
    expect(result['NOTES.draft.md']).toBeUndefined()
  })
})
