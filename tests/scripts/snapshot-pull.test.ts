import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  canonicalQuery,
  credentialsFromEnv,
  defaultLocalBase,
  describeAddOnMiss,
  downloadPrefix,
  encodeKey,
  FLY_ADDON_QUERIES,
  manifestIndexFiles,
  parseArgs,
  parseListXml,
  pickTigrisCredentials,
  planImport,
  readSnapshotDigest,
  resolveBases,
  resolveCredentials,
  sessionDir,
  signGet,
  snapshotDirComplete,
  snapshotPrefixFor,
  versionFromPointer,
} from '../../scripts/snapshot-pull.mjs'

const MANIFEST = {
  default: 'kb',
  bases: [{ name: 'kb', default: true }, { name: 'raylib' }, { name: 'fzf' }],
}

const CREDS = {
  bucket: 'kb-snapshots',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  sessionToken: null,
  endpoint: 'https://fly.storage.tigris.dev',
  region: 'auto',
}

describe('base selection', () => {
  it('[TC-BECU] defaults to the manifest default base', () => {
    expect(resolveBases(parseArgs(['node', 'snapshot-pull.mjs']), MANIFEST)).toEqual(['kb'])
  })

  it('[TC-NRO2] accepts --suite as an alias of --base and dedupes', () => {
    const args = parseArgs(['node', 's', '--suite', 'raylib,fzf', '--base', 'raylib'])
    expect(resolveBases(args, MANIFEST)).toEqual(['raylib', 'fzf'])
  })

  it('[TC-39TL] --all expands to every base in the manifest', () => {
    expect(resolveBases(parseArgs(['node', 's', '--all']), MANIFEST)).toEqual([
      'kb',
      'raylib',
      'fzf',
    ])
  })

  it('[TC-DAQN] rejects a base the manifest never publishes', () => {
    const args = parseArgs(['node', 's', '--base', 'nope'])
    expect(() => resolveBases(args, MANIFEST)).toThrow(/unknown base\(s\): nope/)
  })

  it('[TC-25UV] rejects --into when several bases are pulled', () => {
    expect(() => parseArgs(['node', 's', '--all', '--into', 'x'])).toThrow(/single base/)
  })

  it('[TC-BWRH] rejects unknown flags instead of ignoring them', () => {
    expect(() => parseArgs(['node', 's', '--wat'])).toThrow(/unknown flag: --wat/)
  })

  it('[TC-40BM] maps a fly base to the eval-<base> session and its object prefix', () => {
    expect(defaultLocalBase('raylib')).toBe('eval-raylib')
    expect(snapshotPrefixFor('snapshots', 'raylib')).toBe('snapshots/raylib')
    expect(sessionDir('eval-raylib', { KB_HOME: '/kbhome' })).toBe('/kbhome/sessions/eval-raylib')
  })
})

describe('pointer + listing parsing', () => {
  it('[TC-5LW0] reads the version out of a latest.json pointer', () => {
    expect(versionFromPointer('{"version":"20260803T000000Z","base":"kb"}')).toBe(
      '20260803T000000Z'
    )
    expect(versionFromPointer('not json')).toBeNull()
    expect(versionFromPointer('')).toBeNull()
  })

  it('[TC-F7B9] parses keys, common prefixes and truncation from ListObjectsV2 XML', () => {
    const xml = `<?xml version="1.0"?>
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <Contents><Key>snapshots/kb/v1/kb-snapshot.json</Key></Contents>
        <Contents><Key>snapshots/kb/v1/.kb-index.sqlite</Key></Contents>
        <CommonPrefixes><Prefix>snapshots/kb/v1/</Prefix></CommonPrefixes>
        <NextContinuationToken>tok&amp;2</NextContinuationToken>
      </ListBucketResult>`
    const parsed = parseListXml(xml)
    expect(parsed.keys).toEqual([
      'snapshots/kb/v1/kb-snapshot.json',
      'snapshots/kb/v1/.kb-index.sqlite',
    ])
    expect(parsed.prefixes).toEqual(['snapshots/kb/v1/'])
    expect(parsed.truncated).toBe(true)
    expect(parsed.nextToken).toBe('tok&2')
  })

  it('[TC-USTN] treats an untruncated listing as the final page', () => {
    const parsed = parseListXml('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
    expect(parsed.keys).toEqual([])
    expect(parsed.truncated).toBe(false)
    expect(parsed.nextToken).toBeNull()
  })
})

describe('sigv4 signing', () => {
  it('[TC-AO9G] keeps path separators literal and escapes the rest of a key', () => {
    expect(encodeKey('snapshots/kb/2026 08/.kb-index.sqlite')).toBe(
      'snapshots/kb/2026%2008/.kb-index.sqlite'
    )
  })

  it('[TC-X75S] canonicalizes query parameters in sorted, encoded form', () => {
    expect(canonicalQuery({ prefix: 'snapshots/kb/', 'list-type': 2, empty: null })).toBe(
      'list-type=2&prefix=snapshots%2Fkb%2F'
    )
  })

  it('[TC-78IA] signs a GET deterministically for a fixed clock and credentials', () => {
    const now = new Date('2026-08-03T00:00:00Z')
    const a = signGet({ ...CREDS, key: 'snapshots/kb/latest.json', creds: CREDS, now })
    const b = signGet({ ...CREDS, key: 'snapshots/kb/latest.json', creds: CREDS, now })
    expect(a.headers.authorization).toBe(b.headers.authorization)
    expect(a.headers.authorization).toContain(
      'Credential=AKIDEXAMPLE/20260803/auto/s3/aws4_request'
    )
    expect(a.headers.authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date'
    )
    expect(a.headers['x-amz-date']).toBe('20260803T000000Z')
    expect(a.url).toBe('https://fly.storage.tigris.dev/kb-snapshots/snapshots/kb/latest.json')
  })

  // Golden vectors cross-checked against botocore's SigV4Auth (same clock, same
  // credentials, same canonical request) — an S3 the tests cannot reach would
  // otherwise only ever see this signer agree with itself.
  it('[TC-WXE8] matches a reference SigV4 implementation byte for byte', () => {
    const now = new Date('2026-08-03T00:00:00Z')
    const object = signGet({ ...CREDS, key: 'snapshots/kb/latest.json', creds: CREDS, now })
    expect(object.headers.authorization).toContain(
      'Signature=9834cdba10fdcadddc92269ae9b953a1b3ce1c669c994a0d435d6c42db36bd3b'
    )
    const listing = signGet({
      ...CREDS,
      key: '',
      query: { 'list-type': 2, prefix: 'snapshots/kb/' },
      creds: CREDS,
      now,
    })
    expect(listing.headers.authorization).toContain(
      'Signature=b7b3d87a6011251288da07292d951c5e2a17f542e0e5b760ee8621b265df7d2c'
    )
  })

  it('[TC-4VSL] binds the signature to the object key', () => {
    const now = new Date('2026-08-03T00:00:00Z')
    const one = signGet({ ...CREDS, key: 'a', creds: CREDS, now }).headers.authorization
    const two = signGet({ ...CREDS, key: 'b', creds: CREDS, now }).headers.authorization
    expect(one).not.toBe(two)
  })

  it('[TC-9TCW] signs the security token header when the credentials are temporary', () => {
    const creds = { ...CREDS, sessionToken: 'tok' }
    const signed = signGet({ ...creds, key: 'a', creds, now: new Date('2026-08-03T00:00:00Z') })
    expect(signed.headers['x-amz-security-token']).toBe('tok')
    expect(signed.headers.authorization).toContain('x-amz-security-token')
  })

  it('[TC-U1VZ] appends the canonical query string to the request URL', () => {
    const signed = signGet({
      ...CREDS,
      key: '',
      query: { 'list-type': 2, prefix: 'snapshots/kb/' },
      creds: CREDS,
      now: new Date('2026-08-03T00:00:00Z'),
    })
    expect(signed.url).toBe(
      'https://fly.storage.tigris.dev/kb-snapshots?list-type=2&prefix=snapshots%2Fkb%2F'
    )
  })
})

describe('credential resolution', () => {
  it('[TC-0EWN] prefers explicit bucket credentials from the environment', async () => {
    const creds = await resolveCredentials({
      app: 'kb-demo',
      env: {
        BUCKET_NAME: 'b',
        AWS_ACCESS_KEY_ID: 'k',
        AWS_SECRET_ACCESS_KEY: 's',
      },
      graphql: async () => {
        throw new Error('should not call Fly')
      },
    })
    expect(creds).toMatchObject({ source: 'env', bucket: 'b', endpoint: expect.any(String) })
  })

  it('[TC-EGPX] returns null when the environment is missing a required credential', () => {
    expect(credentialsFromEnv({ BUCKET_NAME: 'b', AWS_ACCESS_KEY_ID: 'k' })).toBeNull()
  })

  it('[TC-BTLZ] reads Tigris keys from the Fly extension listing', async () => {
    const creds = await resolveCredentials({
      app: 'kb-demo',
      env: { FLY_API_TOKEN: 'tok' },
      graphql: async () => ({
        app: {
          addOns: {
            nodes: [
              { name: 'other', environment: { NOT: 's3' } },
              {
                name: 'kb-bucket',
                environment: JSON.stringify({
                  BUCKET_NAME: 'kb-bucket',
                  AWS_ACCESS_KEY_ID: 'tid_x',
                  AWS_SECRET_ACCESS_KEY: 'tsec_x',
                  AWS_ENDPOINT_URL_S3: 'https://fly.storage.tigris.dev',
                }),
              },
            ],
          },
        },
      }),
    })
    expect(creds).toMatchObject({ source: 'fly', bucket: 'kb-bucket', accessKeyId: 'tid_x' })
  })

  it('[TC-UDYL] explains how to supply credentials when none are available', async () => {
    await expect(resolveCredentials({ app: 'kb-demo', env: {} })).rejects.toThrow(
      /BUCKET_NAME .* AWS_ACCESS_KEY_ID .* FLY_API_TOKEN/s
    )
  })

  it('[TC-JRHB] fails loudly when the Fly token yields no storage extension', async () => {
    await expect(
      resolveCredentials({
        app: 'kb-demo',
        env: { FLY_API_TOKEN: 'tok' },
        graphql: async () => ({ app: { addOns: { nodes: [] } } }),
      })
    ).rejects.toThrow(/did not yield bucket credentials/)
  })

  it('[TC-TUAB] asks Fly only for AddOn fields that exist in the schema', () => {
    // `AddOn` exposes `addOnProvider`, not `type`. Asking for `type` fails GraphQL
    // validation, which took out both candidate queries and reported as a generic
    // "did not yield bucket credentials" instead of a schema error.
    for (const candidate of FLY_ADDON_QUERIES) {
      expect(candidate.query).not.toMatch(/\btype\b/)
      expect(candidate.query).toContain('environment')
    }
  })

  it('[TC-LGQL] distinguishes a redacted add-on environment from a missing bucket', () => {
    expect(describeAddOnMiss([])).toMatch(/no storage add-on visible/)
    expect(describeAddOnMiss([{ name: 'kb-demo-storage', environment: {} }])).toMatch(
      /kb-demo-storage.*cannot read extension secrets/
    )
    expect(describeAddOnMiss([{ name: 'kb-demo-storage', environment: '{}' }])).toMatch(
      /cannot read extension secrets/
    )
    expect(describeAddOnMiss([{ name: 'other', environment: { NOT: 's3' } }])).toMatch(
      /no storage add-on with S3 keys.*other/
    )
  })

  it('[TC-WM7M] falls back to the org listing when the app has no add-ons', async () => {
    // `fly storage create` attaches the bucket to the organization, so the
    // app-scoped connection can be empty even though the bucket exists.
    const creds = await resolveCredentials({
      app: 'kb-demo',
      env: { FLY_API_TOKEN: 'tok' },
      graphql: async (_token, query) =>
        query.includes('organizations')
          ? {
              organizations: {
                nodes: [
                  {
                    slug: 'personal',
                    addOns: {
                      nodes: [
                        {
                          name: 'kb-demo-storage',
                          environment: {
                            BUCKET_NAME: 'kb-demo-storage',
                            AWS_ACCESS_KEY_ID: 'tid_x',
                            AWS_SECRET_ACCESS_KEY: 'tsec_x',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            }
          : { app: { addOns: { nodes: [] } } },
    })
    expect(creds).toMatchObject({ source: 'fly', bucket: 'kb-demo-storage' })
  })

  it('[TC-NLON] ignores extensions that are not the requested bucket', () => {
    const nodes = [
      {
        name: 'a',
        environment: { BUCKET_NAME: 'a', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' },
      },
      {
        name: 'b',
        environment: { BUCKET_NAME: 'b', AWS_ACCESS_KEY_ID: 'x2', AWS_SECRET_ACCESS_KEY: 'y2' },
      },
    ]
    expect(pickTigrisCredentials(nodes, { bucketHint: 'b' })).toMatchObject({ bucket: 'b' })
    expect(pickTigrisCredentials([], {})).toBeNull()
  })
})

describe('local adoption', () => {
  it('[TC-MAIK] imports into an empty base without forcing', () => {
    expect(planImport({ baseHasIndex: false, localDigest: null, incomingDigest: 'd', force: false }))
      .toEqual({ action: 'import', force: false })
  })

  it('[TC-P69G] skips the import when the base already holds this snapshot', () => {
    expect(
      planImport({ baseHasIndex: true, localDigest: 'd', incomingDigest: 'd', force: false }).action
    ).toBe('skip')
  })

  it('[TC-GSHR] replaces an older snapshot automatically', () => {
    expect(
      planImport({ baseHasIndex: true, localDigest: 'old', incomingDigest: 'new', force: false })
    ).toMatchObject({ action: 'import', force: true })
  })

  it('[TC-88BA] refuses to clobber a locally built index without --force', () => {
    const plan = planImport({
      baseHasIndex: true,
      localDigest: null,
      incomingDigest: 'new',
      force: false,
    })
    expect(plan.action).toBe('blocked')
    expect(plan.reason).toMatch(/--force/)
  })

  it('[TC-QSZ4] clobbers a locally built index when --force is given', () => {
    expect(
      planImport({ baseHasIndex: true, localDigest: null, incomingDigest: 'new', force: true })
    ).toMatchObject({ action: 'import', force: true })
  })

  it('[TC-7B2Z] treats a prefix missing a required file as incomplete', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snap-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'kb-snapshot.json'), JSON.stringify({ digest: { index: 'abc' } }))
    expect(snapshotDirComplete(dir)).toBe(false)
    writeFileSync(path.join(dir, '.kb-index.sqlite'), 'x')
    expect(snapshotDirComplete(dir)).toBe(true)
    expect(readSnapshotDigest(dir)).toBe('abc')
    expect(readSnapshotDigest(path.join(dir, 'missing'))).toBeNull()
  })
})

describe('snapshot download resilience to a short LIST', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const PREFIX = 'snapshots/kb/20260803T232555Z'
  const MANIFEST_BODY = JSON.stringify({
    kind: 'kb-snapshot',
    schemaVersion: 1,
    contents: { index: ['.kb-index.sqlite'], includesRepos: false },
    digest: { algorithm: 'sha256', index: 'deadbeef' },
  })
  // What object storage really holds, keyed by full object key.
  const ORIGIN: Record<string, string> = {
    [`${PREFIX}/kb-snapshot.json`]: MANIFEST_BODY,
    [`${PREFIX}/.kb-index.sqlite`]: 'SQLITE',
    [`${PREFIX}/source-files-manifest.json`]: '{}',
  }

  /**
   * Stub fetch so LIST and GET can disagree — the Tigris behavior that took
   * kb-demo down. `listed` is what ListObjectsV2 admits to; `gettable`
   * defaults to the full origin.
   */
  function stubS3(listed: string[], gettable: Record<string, string> = ORIGIN) {
    const gets: string[] = []
    globalThis.fetch = (async (url: string) => {
      const parsed = new URL(String(url))
      if (parsed.searchParams.get('list-type') === '2') {
        const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${listed
          .map(k => `<Contents><Key>${k}</Key></Contents>`)
          .join('')}</ListBucketResult>`
        return new Response(xml, { status: 200 })
      }
      const key = decodeURIComponent(parsed.pathname.replace(/^\/[^/]+\//, ''))
      gets.push(key)
      if (!(key in gettable)) return new Response('', { status: 404 })
      return new Response(gettable[key], { status: 200 })
    }) as unknown as typeof fetch
    return gets
  }

  const outDir = () => path.join(mkdtempSync(path.join(tmpdir(), 'kb-pull-')), 'snap')

  it('[TC-ONWZ] recovers a prefix whose LIST is empty but whose objects all GET', async () => {
    const gets = stubS3([])
    const dir = outDir()
    await downloadPrefix(CREDS, PREFIX, dir)
    expect(snapshotDirComplete(dir)).toBe(true)
    expect(readFileSync(path.join(dir, '.kb-index.sqlite'), 'utf8')).toBe('SQLITE')
    // Fetched by exact key, never enumerated.
    expect(gets).toContain(`${PREFIX}/kb-snapshot.json`)
    expect(gets).toContain(`${PREFIX}/.kb-index.sqlite`)
  })

  it('[TC-5Y6Q] recovers a partial LIST that omits the manifest', async () => {
    stubS3([`${PREFIX}/.kb-index.sqlite`])
    const dir = outDir()
    await downloadPrefix(CREDS, PREFIX, dir)
    expect(snapshotDirComplete(dir)).toBe(true)
  })

  it('[TC-NZ5T] leaves a healthy LIST alone and still pulls aux objects', async () => {
    stubS3(Object.keys(ORIGIN))
    const dir = outDir()
    await downloadPrefix(CREDS, PREFIX, dir)
    expect(snapshotDirComplete(dir)).toBe(true)
    expect(existsSync(path.join(dir, 'source-files-manifest.json'))).toBe(true)
  })

  it('[TC-NM9Q] still fails when the prefix is absent by LIST and by GET', async () => {
    stubS3([], {})
    await expect(downloadPrefix(CREDS, PREFIX, outDir())).rejects.toThrow(/missing required objects/)
  })

  it('[TC-4F47] takes index file names from the manifest, always including the primary', () => {
    const dir = outDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'kb-snapshot.json'), MANIFEST_BODY)
    expect(manifestIndexFiles(dir)).toEqual(['.kb-index.sqlite'])

    writeFileSync(
      path.join(dir, 'kb-snapshot.json'),
      JSON.stringify({ contents: { index: ['.kb-index.sqlite', '.kb-index.sqlite-wal'] } })
    )
    expect(manifestIndexFiles(dir)).toEqual(['.kb-index.sqlite', '.kb-index.sqlite-wal'])

    // Manifest missing/older than the field: fall back to the primary index.
    writeFileSync(path.join(dir, 'kb-snapshot.json'), '{}')
    expect(manifestIndexFiles(dir)).toEqual(['.kb-index.sqlite'])
  })
})
