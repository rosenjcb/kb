import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  diffChangedAstFiles,
  readAstFilesManifest,
  writeAstFilesManifest,
} from '@kb/core/ops/init-ast-files-manifest.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('init-ast-files-manifest', () => {
  it('[TC-244] returns null diff when no manifest exists yet (first run)', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-ast-mf-'))
    tempDirs.push(baseDir)
    const manifest = await readAstFilesManifest(baseDir)
    expect(manifest.files).toEqual({})
    expect(diffChangedAstFiles({ 'src/a.ts': 'hash-a' }, manifest)).toBeNull()
  })

  it('[TC-245] round-trips manifest writes and detects changed/new files only', async () => {
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

  it('[TC-246] treats unchanged contents as a no-op diff', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-ast-mf-noop-'))
    tempDirs.push(baseDir)
    const current = { 'src/a.ts': 'hash-a' }
    await writeAstFilesManifest(baseDir, current)
    const manifest = await readAstFilesManifest(baseDir)
    expect(diffChangedAstFiles(current, manifest)).toEqual([])
  })
})
