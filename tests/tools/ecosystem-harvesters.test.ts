import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyPackageKind,
  harvestInfraManifests,
  harvestRepoEntities,
  harvestTypeScriptEcosystem,
} from '@kb/core/tools/ecosystem-harvesters.js'

let scanDir: string

beforeEach(async () => {
  scanDir = await mkdtemp(path.join(os.tmpdir(), 'kb-harvester-'))
})

afterEach(async () => {
  await rm(scanDir, { recursive: true, force: true })
})

async function writePackage(dir: string, pkg: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg))
}

describe('classifyPackageKind', () => {
  it('applies the deterministic kind rubric', () => {
    expect(classifyPackageKind({ dependencies: { express: '4' } }).kind).toBe('service')
    expect(classifyPackageKind({ bin: { kb: './bin/kb' } }).kind).toBe('cli')
    expect(classifyPackageKind({ dependencies: { react: '18' } }).kind).toBe('surface')
    expect(classifyPackageKind({ main: 'index.js' }).kind).toBe('library')
    expect(classifyPackageKind({}).confidence).toBeLessThan(0.5)
  })
})

describe('harvestTypeScriptEcosystem', () => {
  it('enumerates pnpm workspace packages with identity, aliases, and kinds', async () => {
    await writeFile(path.join(scanDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    await writePackage(scanDir, { name: 'acme-monorepo', private: true })
    await writePackage(path.join(scanDir, 'packages', 'client'), {
      name: '@acme/client',
      description: 'Terminal client',
      bin: { acme: './bin/acme' },
    })
    await writePackage(path.join(scanDir, 'packages', 'server'), {
      name: '@acme/server',
      description: 'API daemon',
      dependencies: { express: '^4.0.0' },
      scripts: { start: 'node dist/server.js' },
    })
    await writePackage(path.join(scanDir, 'packages', 'core'), {
      name: '@acme/core',
      main: 'dist/index.js',
    })

    const result = await harvestTypeScriptEcosystem(scanDir)
    const byName = new Map(result.candidates.map(c => [c.canonicalName, c]))

    expect(byName.get('@acme/client')?.kind).toBe('cli')
    expect(byName.get('@acme/client')?.aliases).toContain('acme')
    expect(byName.get('@acme/client')?.aliases).toContain('client')
    expect(byName.get('@acme/server')?.kind).toBe('service')
    expect(byName.get('@acme/server')?.gloss).toBe('API daemon')
    expect(byName.get('@acme/core')?.kind).toBe('library')

    // Workspace membership edges point at the root package.
    expect(result.edges).toContainEqual({
      fromName: '@acme/server',
      toName: 'acme-monorepo',
      edgeType: 'part_of',
    })
  })

  it('falls back to the root package for single-package repos and to nothing without manifests', async () => {
    await writePackage(scanDir, { name: 'solo-svc', dependencies: { fastify: '4' } })
    const single = await harvestTypeScriptEcosystem(scanDir)
    expect(single.candidates).toHaveLength(1)
    expect(single.candidates[0]?.canonicalName).toBe('solo-svc')
    expect(single.candidates[0]?.kind).toBe('service')

    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'kb-harvester-empty-'))
    try {
      const empty = await harvestTypeScriptEcosystem(emptyDir)
      expect(empty.candidates).toHaveLength(0)
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('harvestInfraManifests', () => {
  it('reads compose service keys, fly.toml app names, and Backstage catalog entries', async () => {
    await writeFile(
      path.join(scanDir, 'docker-compose.yml'),
      ['services:', '  payments-svc:', '    image: acme/payments', '  internal:', '    image: acme/internal'].join('\n')
    )
    await writeFile(path.join(scanDir, 'fly.toml'), 'app = "acme-edge"\n[env]\n')
    await writeFile(
      path.join(scanDir, 'catalog-info.yaml'),
      [
        'apiVersion: backstage.io/v1alpha1',
        'kind: Component',
        'metadata:',
        '  name: payments',
        '  description: Payments domain service',
        'spec:',
        '  type: service',
        '  domain: commerce',
      ].join('\n')
    )

    const result = await harvestInfraManifests(scanDir)
    const names = result.candidates.map(c => c.canonicalName).sort()
    expect(names).toEqual(['acme-edge', 'internal', 'payments', 'payments-svc'])
    expect(result.candidates.every(c => c.sourceKind === 'manifest')).toBe(true)
    expect(result.edges).toContainEqual({ fromName: 'payments', toName: 'commerce', edgeType: 'belongs_to' })
  })

  it('is inert on malformed manifests', async () => {
    await writeFile(path.join(scanDir, 'docker-compose.yml'), '{{ not yaml')
    const result = await harvestInfraManifests(scanDir)
    expect(result.candidates).toHaveLength(0)
  })
})

describe('harvestRepoEntities', () => {
  it('merges ecosystem and infra tiers', async () => {
    await writePackage(scanDir, { name: 'edge-worker', dependencies: { koa: '2' } })
    await writeFile(path.join(scanDir, 'fly.toml'), 'app = "edge-worker"\n')
    const result = await harvestRepoEntities(scanDir)
    // Same name from two sources — registry upsert merges them by (kind, name).
    expect(result.candidates.filter(c => c.canonicalName === 'edge-worker')).toHaveLength(2)
  })
})
