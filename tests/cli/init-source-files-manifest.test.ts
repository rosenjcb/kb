import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSourceFileHashes,
  diffChangedSourceFiles,
  diffRemovedSourceFiles,
  hashSourceFileContents,
  readSourceFilesManifest,
  writeSourceFilesManifest,
} from '@kb/core/ops/init-source-files-manifest.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('init-source-files-manifest', () => {
  it('[TC-246] returns null diff when no manifest exists yet (first run)', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-src-mf-'))
    tempDirs.push(baseDir)
    const manifest = await readSourceFilesManifest(baseDir)
    expect(manifest.files).toEqual({})
    const diff = diffChangedSourceFiles({ 'README.md': '# Hello\n' }, manifest)
    expect(diff).toBeNull()
  })

  it('[TC-247] round-trips manifest writes and detects changed/new source files only', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-src-mf-rt-'))
    tempDirs.push(baseDir)
    const v1 = { 'README.md': '# Alpha\n', 'docs/guide.md': '# Beta\n' }
    await writeSourceFilesManifest(baseDir, buildSourceFileHashes(v1))
    const manifest = await readSourceFilesManifest(baseDir)
    expect(manifest.files['README.md']).toBe(hashSourceFileContents('# Alpha\n'))

    const v2 = {
      'README.md': '# Alpha\n',
      'docs/guide.md': '# Beta changed\n',
      'notes.txt': 'gamma\n',
    }
    const diff = diffChangedSourceFiles(v2, manifest)
    expect(diff).not.toBeNull()
    expect(new Set(diff)).toEqual(new Set(['docs/guide.md', 'notes.txt']))
  })

  it('[TC-248] detects source files removed since the last manifest', () => {
    const manifest = {
      version: 1 as const,
      files: { 'README.md': 'a', 'docs/old.md': 'b' },
      updatedAt: '',
    }
    expect(diffRemovedSourceFiles({ 'README.md': '# stay\n' }, manifest)).toEqual(['docs/old.md'])
    expect(diffRemovedSourceFiles({ 'README.md': '# stay\n', 'docs/new.md': '# new\n' }, manifest)).toEqual(
      ['docs/old.md']
    )
    expect(diffRemovedSourceFiles({ 'README.md': '# stay\n', 'docs/old.md': '# old\n' }, manifest)).toEqual([])
    expect(diffRemovedSourceFiles({ 'README.md': '# stay\n' }, { version: 1, files: {}, updatedAt: '' })).toEqual([])
  })

  it('[TC-249] treats unchanged contents as a no-op diff', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-src-mf-noop-'))
    tempDirs.push(baseDir)
    const v1 = { 'README.md': '# Alpha\n' }
    await writeSourceFilesManifest(baseDir, buildSourceFileHashes(v1))
    const manifest = await readSourceFilesManifest(baseDir)
    expect(diffChangedSourceFiles(v1, manifest)).toEqual([])
  })

  it('[TC-427] scopes manifests per repo slug so one repo never clobbers another', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-src-mf-multi-'))
    tempDirs.push(baseDir)

    // Two repos with a COLLIDING repo-relative key (`README.md`) and different contents.
    await writeSourceFilesManifest(baseDir, buildSourceFileHashes({ 'README.md': '# A\n' }), 'repo-a')
    await writeSourceFilesManifest(baseDir, buildSourceFileHashes({ 'README.md': '# B\n' }), 'repo-b')

    const manifestA = await readSourceFilesManifest(baseDir, 'repo-a')
    const manifestB = await readSourceFilesManifest(baseDir, 'repo-b')
    expect(manifestA.files['README.md']).toBe(hashSourceFileContents('# A\n'))
    expect(manifestB.files['README.md']).toBe(hashSourceFileContents('# B\n'))

    // Each repo sees its own content as unchanged (the bug produced "0 unchanged").
    expect(diffChangedSourceFiles({ 'README.md': '# A\n' }, manifestA)).toEqual([])
    expect(diffChangedSourceFiles({ 'README.md': '# B\n' }, manifestB)).toEqual([])

    const entries = await readdir(baseDir)
    expect(entries).toContain('source-files-manifest.repo-a.json')
    expect(entries).toContain('source-files-manifest.repo-b.json')
    expect(entries).not.toContain('source-files-manifest.json')
  })

  it('[TC-428] undefined slug falls back to the un-suffixed legacy filename', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-src-mf-legacy-'))
    tempDirs.push(baseDir)
    await writeSourceFilesManifest(baseDir, buildSourceFileHashes({ 'README.md': '# A\n' }))
    const entries = await readdir(baseDir)
    expect(entries).toEqual(['source-files-manifest.json'])
    // A slug read must NOT fall back to the legacy file — it is a distinct namespace.
    const slugManifest = await readSourceFilesManifest(baseDir, 'repo-a')
    expect(slugManifest.files).toEqual({})
  })
})
