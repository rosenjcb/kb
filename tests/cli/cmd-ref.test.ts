import { describe, expect, it } from 'vitest'
import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from '@kb/core/config/cmd-ref.js'

describe('cmd', () => {
  it('[TC-108] returns /name in tui mode', () => {
    expect(cmd('init', 'tui')).toBe('/init')
  })

  it('[TC-109] returns kb name in cli mode', () => {
    expect(cmd('init', 'cli')).toBe('kb init')
  })

  it('[TC-110] defaults to cli mode', () => {
    expect(cmd('query')).toBe('kb query')
  })

  it('[TC-111] handles multi-word names in tui mode', () => {
    expect(cmd('docs list', 'tui')).toBe('/docs list')
  })

  it('[TC-112] handles multi-word names in cli mode', () => {
    expect(cmd('docs list', 'cli')).toBe('kb docs list')
  })

  it('[TC-113] handles names with flags in tui mode', () => {
    expect(cmd('docs list --limit 5', 'tui')).toBe('/docs list --limit 5')
  })
})

describe('cmdIntro', () => {
  it('[TC-114] returns TUI-style intro in tui mode', () => {
    const intro = cmdIntro('tui')
    expect(intro).toContain('/<command>')
    expect(intro).not.toContain('kb')
  })

  it('[TC-115] returns CLI-style intro in cli mode', () => {
    const intro = cmdIntro('cli')
    expect(intro).toContain('TUI')
    expect(intro).toContain('CLI')
  })
})

describe('cmdHelpHint', () => {
  it('[TC-116] shows /command syntax in tui mode', () => {
    expect(cmdHelpHint('tui')).toContain('/<command>')
  })

  it('[TC-117] shows kb command syntax in cli mode', () => {
    expect(cmdHelpHint('cli')).toContain('kb <command>')
  })
})

describe('CmdMode type', () => {
  it('[TC-118] accepts valid modes without type error', () => {
    const modes: CmdMode[] = ['cli', 'tui']
    expect(modes).toHaveLength(2)
  })
})
