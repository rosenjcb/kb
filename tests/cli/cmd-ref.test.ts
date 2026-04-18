import { describe, it, expect } from 'vitest'
import { cmd, cmdIntro, cmdHelpHint, type CmdMode } from '../../src/cli/cmd-ref'

describe('cmd', () => {
  it('returns /name in tui mode', () => {
    expect(cmd('init', 'tui')).toBe('/init')
  })

  it('returns kb name in cli mode', () => {
    expect(cmd('init', 'cli')).toBe('kb init')
  })

  it('defaults to cli mode', () => {
    expect(cmd('query')).toBe('kb query')
  })

  it('handles multi-word names in tui mode', () => {
    expect(cmd('docs list', 'tui')).toBe('/docs list')
  })

  it('handles multi-word names in cli mode', () => {
    expect(cmd('docs list', 'cli')).toBe('kb docs list')
  })

  it('handles names with flags in tui mode', () => {
    expect(cmd('config llm --show', 'tui')).toBe('/config llm --show')
  })
})

describe('cmdIntro', () => {
  it('returns TUI-style intro in tui mode', () => {
    const intro = cmdIntro('tui')
    expect(intro).toContain('/<command>')
    expect(intro).not.toContain('kb')
  })

  it('returns CLI-style intro in cli mode', () => {
    const intro = cmdIntro('cli')
    expect(intro).toContain('TUI')
    expect(intro).toContain('CLI')
  })
})

describe('cmdHelpHint', () => {
  it('shows /command syntax in tui mode', () => {
    expect(cmdHelpHint('tui')).toContain('/<command>')
  })

  it('shows kb command syntax in cli mode', () => {
    expect(cmdHelpHint('cli')).toContain('kb <command>')
  })
})

describe('CmdMode type', () => {
  it('accepts valid modes without type error', () => {
    const modes: CmdMode[] = ['cli', 'tui']
    expect(modes).toHaveLength(2)
  })
})
