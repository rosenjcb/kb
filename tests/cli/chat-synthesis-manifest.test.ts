import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatManifestNamesForChat } from '@kb/core/query/chat-synthesis.js'
import { EntityRegistry } from '@kb/core/tools/entity-registry.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let baseDir: string
let dbPath: string

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-chat-manifest-'))
  dbPath = path.join(baseDir, '.kb-index.sqlite')
})

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true })
})

describe('formatManifestNamesForChat', () => {
  it('[TC-F87H] Given a manifest entity, then the chat router prompt names that entity', () => {
    const registry = new EntityRegistry(dbPath)
    registry.upsertEntity({
      kind: 'service',
      canonicalName: 'internal',
      sourceKind: 'manifest',
    })
    registry.close()

    const block = formatManifestNamesForChat(baseDir)
    expect(block).toContain('Known manifest names')
    expect(block).toContain('service internal')
  })

  it('[TC-SU7R] Given only harvest entities, then the chat router prompt has no manifest block', () => {
    const registry = new EntityRegistry(dbPath)
    registry.upsertEntity({
      kind: 'service',
      canonicalName: 'kb-server',
      sourceKind: 'harvest',
    })
    registry.close()

    expect(formatManifestNamesForChat(baseDir)).toBe('')
    expect(formatManifestNamesForChat(undefined)).toBe('')
  })
})
