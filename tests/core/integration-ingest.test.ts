import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestIntegrationSignals } from '../../src/core/integration-ingest'
import { type FactRow, SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

let baseDir: string
let scanDir: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-integration-ingest-base-'))
  scanDir = await mkdtemp(path.join(os.tmpdir(), 'kb-integration-ingest-scan-'))
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
  await rm(scanDir, { recursive: true, force: true })
})

function liveFacts(): FactRow[] {
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  try {
    return indexer.listFactsForQuery(9999).filter(f => !f.tombstoned_at)
  } finally {
    indexer.close()
  }
}

describe('ingestIntegrationSignals', () => {
  it('emits package_name_of, depends_on, and is_repo facts from package.json', async () => {
    await writeFile(
      path.join(scanDir, 'package.json'),
      JSON.stringify({ name: '@acme/auth', dependencies: { '@acme/shared': '1.0.0' }, devDependencies: { vitest: '3' } })
    )

    const result = await ingestIntegrationSignals({
      baseDir,
      scanDir,
      gitRepo: 'acme-auth',
      gitUrl: 'https://github.com/acme/auth',
    })

    expect(result.packageName).toBe('@acme/auth')
    expect(result.dependencyFacts).toBe(2)

    const facts = liveFacts()
    const byPredicate = (p: string) => facts.filter(f => f.predicate === p)
    expect(byPredicate('package_name_of')[0]).toMatchObject({ subject: '@acme/auth', object: 'acme-auth' })
    expect(byPredicate('depends_on').map(f => f.object).sort()).toEqual(['@acme/shared', 'vitest'])
    expect(byPredicate('is_repo')[0]?.object).toBe('https://github.com/acme/auth')
    // Every fact is tagged with the repo slug.
    expect(facts.every(f => f.git_repo === 'acme-auth')).toBe(true)
  })

  it('extracts service hosts from .env URL values', async () => {
    await writeFile(
      path.join(scanDir, '.env'),
      ['# comment', 'PORT=3000', 'AUTH_URL=https://auth-svc.internal/login', 'LOCAL=http://localhost:5432'].join('\n')
    )

    const result = await ingestIntegrationSignals({ baseDir, scanDir, gitRepo: 'web' })

    expect(result.serviceRefFacts).toBe(1) // localhost is filtered out
    const refs = liveFacts().filter(f => f.predicate === 'references_service')
    expect(refs[0]?.object).toBe('auth-svc.internal')
  })

  it('re-ingest clears stale integration facts (removed dependency disappears)', async () => {
    await writeFile(path.join(scanDir, 'package.json'), JSON.stringify({ name: 'svc', dependencies: { old: '1' } }))
    await ingestIntegrationSignals({ baseDir, scanDir, gitRepo: 'svc' })
    expect(liveFacts().some(f => f.predicate === 'depends_on' && f.object === 'old')).toBe(true)

    await writeFile(path.join(scanDir, 'package.json'), JSON.stringify({ name: 'svc', dependencies: { fresh: '1' } }))
    await ingestIntegrationSignals({ baseDir, scanDir, gitRepo: 'svc' })

    const deps = liveFacts().filter(f => f.predicate === 'depends_on').map(f => f.object)
    expect(deps).toContain('fresh')
    expect(deps).not.toContain('old')
  })
})
