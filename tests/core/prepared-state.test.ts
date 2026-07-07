import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION } from '@kb/core/core/db-migrations.js'
import type { BaseRepo } from '@kb/core/storage/base-repos.js'
import {
  PREPARED_STATE_KIND,
  PREPARED_STATE_SCHEMA_VERSION,
  buildPreparedStateManifest,
  checkPreparedStateCompatibility,
  computeFileDigest,
  normalizePreparedStateManifest,
  readPreparedStateManifest,
  writePreparedStateManifest,
} from '@kb/core/storage/prepared-state.js'

const REPOS: BaseRepo[] = [
  {
    gitUrl: 'https://example.com/org/repo.git',
    gitBranch: 'main',
    slug: 'org-repo',
    dir: 'repos/org-repo',
  },
]

describe('buildPreparedStateManifest', () => {
  it('stamps kind, schema, provenance, compat, and digest', () => {
    const manifest = buildPreparedStateManifest({
      base: 'demo',
      repos: REPOS,
      indexFiles: ['.kb-index.sqlite'],
      indexDigest: 'deadbeef',
      includesRepos: false,
      tool: 'kb-server',
      toolVersion: '9.9.9',
      createdAt: '2026-07-07T12:00:00.000Z',
    })
    expect(manifest.kind).toBe(PREPARED_STATE_KIND)
    expect(manifest.schemaVersion).toBe(PREPARED_STATE_SCHEMA_VERSION)
    expect(manifest.createdAt).toBe('2026-07-07T12:00:00.000Z')
    expect(manifest.compat.indexSchema).toBe(LATEST_SCHEMA_VERSION)
    expect(manifest.contents).toEqual({ index: ['.kb-index.sqlite'], includesRepos: false })
    expect(manifest.provenance.base).toBe('demo')
    expect(manifest.provenance.repos).toEqual([
      {
        gitUrl: 'https://example.com/org/repo.git',
        gitBranch: 'main',
        slug: 'org-repo',
      },
    ])
    expect(manifest.producer).toMatchObject({ tool: 'kb-server', toolVersion: '9.9.9' })
    expect(manifest.digest).toEqual({ algorithm: 'sha256', index: 'deadbeef' })
  })

  it('omits toolVersion when not provided and tolerates null meta', () => {
    const manifest = buildPreparedStateManifest({
      base: 'demo',
      repos: [],
      indexFiles: ['.kb-index.sqlite'],
      indexDigest: 'x',
      includesRepos: true,
      tool: 'kb',
    })
    expect(manifest.producer.toolVersion).toBeUndefined()
    expect(manifest.provenance.repos).toEqual([])
    expect(manifest.contents.includesRepos).toBe(true)
  })
})

describe('checkPreparedStateCompatibility', () => {
  const base = buildPreparedStateManifest({
    base: 'demo',
    repos: REPOS,
    indexFiles: ['.kb-index.sqlite'],
    indexDigest: 'x',
    includesRepos: false,
    tool: 'kb-server',
  })

  it('accepts a bundle the consumer is new enough to open', () => {
    expect(checkPreparedStateCompatibility(base)).toEqual({ ok: true })
    expect(
      checkPreparedStateCompatibility(base, {
        indexSchema: LATEST_SCHEMA_VERSION + 5,
        manifestSchema: PREPARED_STATE_SCHEMA_VERSION,
      })
    ).toEqual({ ok: true })
  })

  it('rejects a bundle whose index schema is newer than the consumer', () => {
    const result = checkPreparedStateCompatibility(base, {
      indexSchema: LATEST_SCHEMA_VERSION - 1,
      manifestSchema: PREPARED_STATE_SCHEMA_VERSION,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/index schema/)
  })

  it('rejects a manifest newer than the consumer understands', () => {
    const result = checkPreparedStateCompatibility(
      { ...base, schemaVersion: PREPARED_STATE_SCHEMA_VERSION + 1 },
      { indexSchema: LATEST_SCHEMA_VERSION, manifestSchema: PREPARED_STATE_SCHEMA_VERSION }
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/manifest schema/)
  })

  it('rejects a foreign artifact whose kind is wrong', () => {
    const result = checkPreparedStateCompatibility({
      ...base,
      kind: 'something-else' as typeof PREPARED_STATE_KIND,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not a prepared-state manifest/)
  })
})

describe('normalizePreparedStateManifest', () => {
  const valid = buildPreparedStateManifest({
    base: 'demo',
    repos: REPOS,
    indexFiles: ['.kb-index.sqlite'],
    indexDigest: 'x',
    includesRepos: false,
    tool: 'kb-server',
  })

  it('round-trips a valid manifest', () => {
    expect(normalizePreparedStateManifest(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })

  it.each([
    ['non-object', 42],
    ['wrong kind', { ...valid, kind: 'nope' }],
    ['missing compat', { ...valid, compat: undefined }],
    ['bad digest', { ...valid, digest: { algorithm: 'md5', index: 'x' } }],
    ['missing provenance', { ...valid, provenance: undefined }],
  ])('throws on %s', (_label, input) => {
    expect(() => normalizePreparedStateManifest(input)).toThrow()
  })
})

describe('read/write manifest + digest (IO)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kb-prepared-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a manifest through the filesystem', async () => {
    const manifest = buildPreparedStateManifest({
      base: 'demo',
      repos: REPOS,
      indexFiles: ['.kb-index.sqlite'],
      indexDigest: 'x',
      includesRepos: false,
      tool: 'kb-server',
    })
    await writePreparedStateManifest(dir, manifest)
    expect(await readPreparedStateManifest(dir)).toEqual(manifest)
  })

  it('returns null when no manifest is present', async () => {
    expect(await readPreparedStateManifest(dir)).toBeNull()
  })

  it('computes a stable sha256 digest of a file', async () => {
    const file = path.join(dir, 'data.bin')
    writeFileSync(file, 'hello world')
    // sha256("hello world")
    expect(await computeFileDigest(file)).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    )
  })
})
