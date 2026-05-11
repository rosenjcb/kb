import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSourceFileHashes,
  diffChangedSourceFiles,
  hashSourceFileContents,
  readSourceFilesManifest,
  writeSourceFilesManifest,
} from '../../src/cli/init-source-files-manifest'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('init-source-files-manifest', () => {
  it('returns null diff when no manifest exists yet (first run)', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-src-mf-'))
    tempDirs.push(baseDir)
    const manifest = await readSourceFilesManifest(baseDir)
    expect(manifest.files).toEqual({})
    const diff = diffChangedSourceFiles({ 'README.md': '# Hello\n' }, manifest)
    expect(diff).toBeNull()
  })

  it('round-trips manifest writes and detects changed/new source files only', async () => {
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

  it('treats unchanged contents as a no-op diff', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-src-mf-noop-'))
    tempDirs.push(baseDir)
    const v1 = { 'README.md': '# Alpha\n' }
    await writeSourceFilesManifest(baseDir, buildSourceFileHashes(v1))
    const manifest = await readSourceFilesManifest(baseDir)
    expect(diffChangedSourceFiles(v1, manifest)).toEqual([])
  })
})
