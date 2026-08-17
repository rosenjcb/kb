import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestIntegrationSignals } from '@kb/core/core/integration-ingest.js'
import { type FactRow, SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'

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
  it('[TC-0V5Q] emits package_name_of, depends_on, and is_repo facts from package.json', async () => {
    await writeFile(
      path.join(scanDir, 'package.json'),
      JSON.stringify({
        name: '@acme/auth',
        dependencies: { '@acme/shared': '1.0.0' },
        devDependencies: { vitest: '3' },
      })
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
    const texts = facts.map(f => f.text)
    expect(texts.some(t => t.includes('Package @acme/auth') && t.includes('acme-auth'))).toBe(true)
    expect(texts.some(t => t.includes('depends on package @acme/shared'))).toBe(true)
    expect(texts.some(t => t.includes('depends on package vitest'))).toBe(true)
    expect(texts.some(t => t.includes('https://github.com/acme/auth'))).toBe(true)
    expect(facts.every(f => f.git_repo === 'acme-auth')).toBe(true)
  })

  it('[TC-ZC86] extracts service hosts from .env URL values', async () => {
    await writeFile(
      path.join(scanDir, '.env'),
      ['# comment', 'PORT=3000', 'AUTH_URL=https://auth-svc.internal/login', 'LOCAL=http://localhost:5432'].join(
        '\n'
      )
    )

    const result = await ingestIntegrationSignals({ baseDir, scanDir, gitRepo: 'web' })

    expect(result.serviceRefFacts).toBe(1)
    expect(
      liveFacts().some(f => f.text.includes('references service auth-svc.internal'))
    ).toBe(true)
  })

  it('[TC-8VVX] re-ingest clears stale integration facts (removed dependency disappears)', async () => {
    await writeFile(path.join(scanDir, 'package.json'), JSON.stringify({ name: 'svc', dependencies: { old: '1' } }))
    await ingestIntegrationSignals({ baseDir, scanDir, gitRepo: 'svc' })
    expect(liveFacts().some(f => f.text.includes('depends on package old'))).toBe(true)

    await writeFile(path.join(scanDir, 'package.json'), JSON.stringify({ name: 'svc', dependencies: { fresh: '1' } }))
    await ingestIntegrationSignals({ baseDir, scanDir, gitRepo: 'svc' })

    const texts = liveFacts().map(f => f.text)
    expect(texts.some(t => t.includes('depends on package fresh'))).toBe(true)
    expect(texts.some(t => t.includes('depends on package old'))).toBe(false)
  })
})
