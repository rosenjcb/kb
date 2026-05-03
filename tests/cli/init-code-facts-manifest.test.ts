import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHashesFor,
  diffChangedFiles,
  hashFileContents,
  readCodeFactsManifest,
  writeCodeFactsManifest,
} from '../../src/cli/init-code-facts-manifest'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('init-code-facts-manifest', () => {
  it('returns null diff when no manifest exists yet (first run)', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-cf-mf-'))
    tempDirs.push(baseDir)
    const manifest = await readCodeFactsManifest(baseDir)
    expect(manifest.files).toEqual({})
    const diff = diffChangedFiles({ 'src/a.ts': 'hello' }, manifest)
    expect(diff).toBeNull()
  })

  it('round-trips manifest writes and detects changed/new files only', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-cf-mf-rt-'))
    tempDirs.push(baseDir)
    const v1 = { 'src/a.ts': 'alpha', 'src/b.ts': 'beta' }
    await writeCodeFactsManifest(baseDir, buildHashesFor(v1))
    const manifest = await readCodeFactsManifest(baseDir)
    expect(manifest.files['src/a.ts']).toBe(hashFileContents('alpha'))

    const v2 = { 'src/a.ts': 'alpha', 'src/b.ts': 'beta-changed', 'src/c.ts': 'gamma' }
    const diff = diffChangedFiles(v2, manifest)
    expect(diff).not.toBeNull()
    expect(new Set(diff)).toEqual(new Set(['src/b.ts', 'src/c.ts']))
  })

  it('treats unchanged contents as a no-op diff', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-cf-mf-noop-'))
    tempDirs.push(baseDir)
    const v1 = { 'src/a.ts': 'alpha' }
    await writeCodeFactsManifest(baseDir, buildHashesFor(v1))
    const manifest = await readCodeFactsManifest(baseDir)
    expect(diffChangedFiles(v1, manifest)).toEqual([])
  })
})
