import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBaseMeta, writeBaseMeta, type GitBaseMeta } from '../../src/cli/base-meta'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kb-base-meta-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const sample: GitBaseMeta = {
  gitUrl: 'https://github.com/org/repo',
  gitBranch: 'main',
  lastSyncedSha: 'abc1234defabc1234defabc1234defabc1234def',
  lastSyncedAt: '2026-06-01T00:00:00.000Z',
}

describe('base-meta', () => {
  it('readBaseMeta returns null when meta.json does not exist', async () => {
    const result = await readBaseMeta(tmpDir)
    expect(result).toBeNull()
  })

  it('writeBaseMeta then readBaseMeta round-trips the metadata', async () => {
    await writeBaseMeta(tmpDir, sample)
    const result = await readBaseMeta(tmpDir)
    expect(result).toEqual(sample)
  })

  it('writeBaseMeta overwrites existing metadata', async () => {
    await writeBaseMeta(tmpDir, sample)
    const updated: GitBaseMeta = { ...sample, lastSyncedSha: 'newsha', lastSyncedAt: '2026-06-02T00:00:00.000Z' }
    await writeBaseMeta(tmpDir, updated)
    const result = await readBaseMeta(tmpDir)
    expect(result?.lastSyncedSha).toBe('newsha')
  })
})
