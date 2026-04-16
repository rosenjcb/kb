import { describe, expect, it } from 'vitest'
import { GraphCommandError, parseGraphCommand, printGraphHelp } from '../../src/cli/graph-cli'

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
