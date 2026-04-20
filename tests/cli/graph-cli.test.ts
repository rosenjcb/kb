import { describe, expect, it, vi } from 'vitest'
import {
  GraphCommandError,
  parseGraphCommand,
  printGraphHelp,
  runGraphCommand,
} from '../../src/cli/graph-cli'
import type { GraphWriter } from '../../src/cli/graph-cli'

// ---------------------------------------------------------------------------
// Stub writer — injected directly via writerOverride parameter
// ---------------------------------------------------------------------------

const mockSummary = {
  totalEntities: 3,
  totalRelationships: 2,
  topEntities: [{ id: 'kb', name: 'KB', type: 'system', connections: 5 }],
}

function makeMockWriter(overrides: Partial<GraphWriter> = {}): GraphWriter {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getSummary: vi.fn().mockResolvedValue(mockSummary),
    exportDot: vi.fn().mockResolvedValue('digraph {}'),
    exportJson: vi.fn().mockResolvedValue({ entities: [], relationships: [] }),
    findPath: vi.fn().mockResolvedValue(null),
    getNeighbors: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

describe('graph-cli parsing', () => {
  it('Given graph help flag, then parser returns graph-specific help text', () => {
    try {
      parseGraphCommand(['--help'])
      throw new Error('expected help error')
    } catch (error) {
      expect(error).toBeInstanceOf(GraphCommandError)
      expect((error as GraphCommandError).exitCode).toBe(0)
      expect((error as Error).message).toContain('kb graph commands')
      expect((error as Error).message).toContain('kb graph --entity <name>')
    }
  })

  it('Given graph entity flag, then parser returns entity lookup options', () => {
    expect(parseGraphCommand(['--entity', 'KB'])).toEqual({ entity: 'KB' })
  })

  it('Given graph path flag, then parser returns path lookup options', () => {
    expect(parseGraphCommand(['--path', 'KB', 'SQLite'])).toEqual({
      pathFrom: 'KB',
      pathTo: 'SQLite',
    })
  })

  it('Given graph format flag, then parser returns export format option', () => {
    expect(parseGraphCommand(['--format', 'json'])).toEqual({ format: 'json' })
  })
})

describe('graph-cli help', () => {
  it('prints grouped graph usage and examples', () => {
    const help = printGraphHelp()
    expect(help).toContain('kb graph commands')
    expect(help).toContain('Usage:')
    expect(help).toContain('Examples:')
  })
})

describe('runGraphCommand — output routing', () => {
  it('routes default summary output through the out parameter, not console.log', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand('/fake/base', {}, out, makeMockWriter())

    expect(lines.some(l => l.includes('Knowledge graph summary'))).toBe(true)
    expect(lines.some(l => l.includes('Entities:'))).toBe(true)
    expect(lines.some(l => l.includes('Relationships:'))).toBe(true)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('routes --format dot output through the out parameter', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand('/fake/base', { format: 'dot' }, out, makeMockWriter())

    expect(lines.some(l => l.includes('digraph'))).toBe(true)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('routes --format json output through the out parameter', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand('/fake/base', { format: 'json' }, out, makeMockWriter())

    expect(lines.length).toBeGreaterThan(0)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('reports no-path-found through the out parameter', async () => {
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand('/fake/base', { pathFrom: 'A', pathTo: 'B' }, out, makeMockWriter())

    expect(lines.some(l => l.includes('No path found'))).toBe(true)
  })

  it('reports entity-not-found through the out parameter', async () => {
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }

    await runGraphCommand('/fake/base', { entity: 'Unknown' }, out, makeMockWriter())

    expect(lines.some(l => l.includes('not found'))).toBe(true)
  })
})
