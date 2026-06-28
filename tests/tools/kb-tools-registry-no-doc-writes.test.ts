import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createKBToolsRegistry } from '../../src/tools/kb-tools-registry'

const FORBIDDEN = new Set([
  'write_document',
  'append_to_document',
  'update_document',
  'prune_document',
  'merge_documents',
  'reconcile_facts',
  'reconcile_contradictions',
  'read_documents',
  'invalidate_graph_documents',
])

describe('createKBToolsRegistry', () => {
  it('[TC-51] does not register markdown-era doc-write or legacy graph/read tool names', async () => {
    const base = path.join(
      process.cwd(),
      'tmp-registry-surface',
      `b-${Math.random().toString(36).slice(2)}`
    )
    await mkdir(base, { recursive: true })
    try {
      const reg = createKBToolsRegistry(base)
      const names = new Set(reg.getTools().map(t => t.name))
      for (const bad of FORBIDDEN) {
        expect(names.has(bad), `forbidden tool registered: ${bad}`).toBe(false)
      }
      expect(names.has('read_facts')).toBe(true)
      expect(names.has('upsert_fact')).toBe(true)
    } finally {
      await rm(path.join(process.cwd(), 'tmp-registry-surface'), { recursive: true, force: true })
    }
  })
})
