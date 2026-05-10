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

  it('Given graph node mutation command, then parser rejects read-only writes', () => {
    expect(() => parseGraphCommand(['node', 'add', '--name', 'My API'])).toThrow(
      /read-only/i
    )
  })

  it('Given graph edge mutation command, then parser rejects read-only writes', () => {
    expect(() => parseGraphCommand(['edge', 'add', '--from', 'a', '--to', 'b', '--verb', 'uses'])).toThrow(
      /read-only/i
    )
  })
})

describe('graph-cli help', () => {
  it('prints grouped graph usage and examples', () => {
    const help = printGraphHelp()
    expect(help).toContain('kb graph commands')
    expect(help).toContain('Inspect:')
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

  it('shows next-hop exploration details for outgoing neighbors', async () => {
    const lines: string[] = []
    const out = { log: (msg: string) => lines.push(msg) }
    const writer = makeMockWriter({
      getNeighbors: vi.fn(async entity => {
        if (entity === 'KB') {
          return {
            entity: { id: 'kb', name: 'KB', type: 'system' },
            outgoing: [{ rel: 'uses', target: { id: 'api', name: 'API', type: 'tool' } }],
            incoming: [{ rel: 'queried_by', source: { id: 'cli', name: 'CLI', type: 'tool' } }],
          }
        }
        if (entity === 'api') {
          return {
            entity: { id: 'api', name: 'API', type: 'tool' },
            outgoing: [
              { rel: 'calls', target: { id: 'auth', name: 'Auth', type: 'system' } },
              { rel: 'reads', target: { id: 'db', name: 'DB', type: 'system' } },
            ],
            incoming: [{ rel: 'uses', source: { id: 'kb', name: 'KB', type: 'system' } }],
          }
        }
        return null
      }),
    })

    await runGraphCommand('/fake/base', { entity: 'KB' }, out, writer)

    expect(lines.some(l => l.includes('Next-hop exploration:'))).toBe(true)
    expect(lines.some(l => l.includes('API [tool] can reach:'))).toBe(true)
    expect(lines.some(l => l.includes('-[calls]→ Auth [system]'))).toBe(true)
    expect(lines.some(l => l.includes('-[reads]→ DB [system]'))).toBe(true)
  })
})
