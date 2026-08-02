import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  diffChangedAstFiles,
  diffRemovedAstFiles,
  readAstFilesManifest,
  writeAstFilesManifest,
} from '@kb/core/ops/init-ast-files-manifest.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('init-ast-files-manifest', () => {
  it('[TC-193] returns null diff when no manifest exists yet (first run)', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-ast-mf-'))
    tempDirs.push(baseDir)
    const manifest = await readAstFilesManifest(baseDir)
    expect(manifest.files).toEqual({})
    expect(diffChangedAstFiles({ 'src/a.ts': 'hash-a' }, manifest)).toBeNull()
  })

  it('[TC-194] round-trips manifest writes and detects changed/new files only', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-ast-mf-rt-'))
    tempDirs.push(baseDir)
    await writeAstFilesManifest(baseDir, {
      'src/a.ts': 'hash-a',
      'tsconfig.json': 'hash-config-a',
    })
    const manifest = await readAstFilesManifest(baseDir)

    const diff = diffChangedAstFiles(
      {
        'src/a.ts': 'hash-a',
        'tsconfig.json': 'hash-config-b',
        'src/b.ts': 'hash-b',
      },
      manifest
    )

    expect(new Set(diff ?? [])).toEqual(new Set(['tsconfig.json', 'src/b.ts']))
  })

  it('[TC-195] treats unchanged contents as a no-op diff', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-ast-mf-noop-'))
    tempDirs.push(baseDir)
    const current = { 'src/a.ts': 'hash-a' }
    await writeAstFilesManifest(baseDir, current)
    const manifest = await readAstFilesManifest(baseDir)
    expect(diffChangedAstFiles(current, manifest)).toEqual([])
  })

  it('[TC-424] scopes manifests per repo slug so one repo never clobbers another', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-ast-mf-multi-'))
    tempDirs.push(baseDir)

    // Two repos with a COLLIDING repo-relative key (`src/index.ts`) and different hashes.
    await writeAstFilesManifest(baseDir, { 'src/index.ts': 'hash-a' }, 'repo-a')
    await writeAstFilesManifest(baseDir, { 'src/index.ts': 'hash-b' }, 'repo-b')

    // repo-b's write must NOT have clobbered repo-a's manifest.
    const manifestA = await readAstFilesManifest(baseDir, 'repo-a')
    const manifestB = await readAstFilesManifest(baseDir, 'repo-b')
    expect(manifestA.files['src/index.ts']).toBe('hash-a')
    expect(manifestB.files['src/index.ts']).toBe('hash-b')

    // Each repo sees its own hashes as unchanged (the bug produced "0 unchanged").
    expect(diffChangedAstFiles({ 'src/index.ts': 'hash-a' }, manifestA)).toEqual([])
    expect(diffChangedAstFiles({ 'src/index.ts': 'hash-b' }, manifestB)).toEqual([])

    // Distinct on-disk files, and neither is the un-suffixed legacy filename.
    const entries = await readdir(baseDir)
    expect(entries).toContain('ast-files-manifest.repo-a.json')
    expect(entries).toContain('ast-files-manifest.repo-b.json')
    expect(entries).not.toContain('ast-files-manifest.json')
  })

  it('[TC-425] undefined slug falls back to the un-suffixed legacy filename', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-ast-mf-legacy-'))
    tempDirs.push(baseDir)
    await writeAstFilesManifest(baseDir, { 'src/a.ts': 'hash-a' })
    const entries = await readdir(baseDir)
    expect(entries).toEqual(['ast-files-manifest.json'])
    // A slug read must NOT fall back to the legacy file — it is a distinct namespace.
    const slugManifest = await readAstFilesManifest(baseDir, 'repo-a')
    expect(slugManifest.files).toEqual({})
  })

  it('[TC-426] detects AST files removed since the last manifest', () => {
    const manifest = {
      version: 1 as const,
      files: { 'src/a.ts': 'h-a', 'src/gone.ts': 'h-gone' },
      updatedAt: '',
    }
    expect(diffRemovedAstFiles({ 'src/a.ts': 'h-a' }, manifest)).toEqual(['src/gone.ts'])
    expect(diffRemovedAstFiles({ 'src/a.ts': 'h-a', 'src/gone.ts': 'h-gone' }, manifest)).toEqual([])
    expect(diffRemovedAstFiles({ 'src/a.ts': 'h-a' }, { version: 1, files: {}, updatedAt: '' })).toEqual([])
  })
})
