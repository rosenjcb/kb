import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatGraphRelationBlockForPair,
  formatGraphRelationBlockFromQuestion,
  parseRelationalConceptPair,
} from '../../src/tools/graph-relation-context'
import { KbGraphWriter } from '../../src/tools/kb-graph-writer'

describe('parseRelationalConceptPair', () => {
  it('parses how does X relate to Y', () => {
    expect(parseRelationalConceptPair('How does retrieval relate to storage?')).toEqual({
      phraseA: 'retrieval',
      phraseB: 'storage',
    })
  })

  it('parses relationship between X and Y', () => {
    expect(parseRelationalConceptPair('relationship between SQLite and the graph')).toEqual({
      phraseA: 'SQLite',
      phraseB: 'the graph',
    })
  })

  it('returns null for non-relational queries', () => {
    expect(parseRelationalConceptPair('What is precedence order?')).toBeNull()
  })
})

describe('formatGraphRelationBlockForPair', () => {
  let tmpDir: string
  let dbPath: string
  let writer: KbGraphWriter

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kb-relation-'))
    dbPath = join(tmpDir, '.kb-index.sqlite')
    writer = new KbGraphWriter(dbPath)
    await writer.open()
    await writer.beginTransaction()
    await writer.upsertEntities([
      { id: 'alpha', name: 'Alpha', type: 'concept' },
      { id: 'beta', name: 'Beta', type: 'concept' },
      { id: 'gamma', name: 'Gamma', type: 'concept' },
    ])
    await writer.upsertRelationships([
      { fromId: 'alpha', toId: 'beta', type: 'uses', weight: 1 },
      { fromId: 'beta', toId: 'gamma', type: 'implements', weight: 1 },
    ])
    await writer.commit()
  })

  afterEach(async () => {
    await writer.close().catch(() => {})
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('formats shortest path with edge labels', async () => {
    const block = await formatGraphRelationBlockForPair(writer, {
      phraseA: 'Alpha',
      phraseB: 'Gamma',
    })
    expect(block).toContain('Shortest directed path')
    expect(block).toContain('Alpha')
    expect(block).toContain('Gamma')
    expect(block).toContain('[uses]')
    expect(block).toContain('[implements]')
  })

  it('finds path when concepts are given in reverse order', async () => {
    const block = await formatGraphRelationBlockFromQuestion(
      writer,
      'How does Gamma relate to Alpha?'
    )
    expect(block).toContain('Gamma')
    expect(block).toContain('Alpha')
  })
})
