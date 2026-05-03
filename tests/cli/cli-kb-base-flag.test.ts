import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureOperationalBaseDir, writeSessionBase } from '../../src/cli/base-selection'
import { runMainWithOutput } from '../../src/cli/index'
import { KbGraphWriter } from '../../src/tools/kb-graph-writer'

function makeOut() {
  const lines: string[] = []
  return {
    out: {
      log: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
      write: (m: string) => lines.push(m),
    },
    lines,
  }
}

describe('CLI --base override', () => {
  let kbHome: string

  beforeEach(async () => {
    kbHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-base-flag-'))
    process.env.KB_HOME = kbHome
  })

  afterEach(async () => {
    delete process.env.KB_HOME
    await rm(kbHome, { recursive: true, force: true })
  })

  it('Given active base A and graph data only on B, kb graph --base B reads B graph', async () => {
    await ensureOperationalBaseDir('base-a')
    await ensureOperationalBaseDir('base-b')
    const bDir = path.join(kbHome, 'sessions', 'base-b')
    const gw = new KbGraphWriter(KbGraphWriter.dbPathForBase(bDir))
    await gw.open()
    await gw.upsertEntities([{ id: 'only-b', name: 'Only B marker', type: 'concept' }])
    await gw.close()

    await writeSessionBase('base-a')

    const { out, lines } = makeOut()
    await runMainWithOutput(
      ['graph', '--format', 'json', '--base', 'base-b'],
      out,
      {} as never,
      'cli'
    )

    const text = lines.join('\n')
    const i = text.indexOf('{')
    expect(i).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(text.slice(i)) as { entities: Array<{ id: string }> }
    expect(parsed.entities.some(e => e.id === 'only-b')).toBe(true)
  })

  it('Given strip order, kb graph parses flags after --base', async () => {
    await ensureOperationalBaseDir('base-a')
    await ensureOperationalBaseDir('base-b')
    const bDir = path.join(kbHome, 'sessions', 'base-b')
    const gw = new KbGraphWriter(KbGraphWriter.dbPathForBase(bDir))
    await gw.open()
    await gw.upsertEntities([{ id: 'edge-a', name: 'edge-a', type: 'concept' }])
    await gw.upsertEntities([{ id: 'edge-b', name: 'edge-b', type: 'concept' }])
    await gw.upsertRelationships([{ fromId: 'edge-a', toId: 'edge-b', type: 'related_to' }])
    await gw.close()

    await writeSessionBase('base-a')

    const { out, lines } = makeOut()
    await runMainWithOutput(
      ['graph', '--base', 'base-b', '--path', 'edge-a', 'edge-b'],
      out,
      {} as never,
      'cli'
    )

    expect(lines.some(l => l.includes('hop'))).toBe(true)
  })
})
