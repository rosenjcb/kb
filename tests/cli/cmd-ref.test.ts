import { describe, expect, it } from 'vitest'
import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from '@kb/core/config/cmd-ref.js'

describe('cmd', () => {
  it('[TC-84] returns /name in tui mode', () => {
    expect(cmd('init', 'tui')).toBe('/init')
  })

  it('[TC-85] returns kb name in cli mode', () => {
    expect(cmd('init', 'cli')).toBe('kb init')
  })

  it('[TC-86] defaults to cli mode', () => {
    expect(cmd('query')).toBe('kb query')
  })

  it('[TC-87] handles multi-word names in tui mode', () => {
    expect(cmd('facts list', 'tui')).toBe('/facts list')
  })

  it('[TC-88] handles multi-word names in cli mode', () => {
    expect(cmd('facts list', 'cli')).toBe('kb facts list')
  })

  it('[TC-89] handles names with flags in tui mode', () => {
    expect(cmd('facts list --limit 5', 'tui')).toBe('/facts list --limit 5')
  })
})

describe('cmdIntro', () => {
  it('[TC-90] returns TUI-style intro in tui mode', () => {
    const intro = cmdIntro('tui')
    expect(intro).toContain('/<command>')
    expect(intro).not.toContain('kb')
  })

  it('[TC-91] returns CLI-style intro in cli mode', () => {
    const intro = cmdIntro('cli')
    expect(intro).toContain('TUI')
    expect(intro).toContain('CLI')
  })
})

describe('cmdHelpHint', () => {
  it('[TC-92] shows /command syntax in tui mode', () => {
    expect(cmdHelpHint('tui')).toContain('/<command>')
  })

  it('[TC-93] shows kb command syntax in cli mode', () => {
    expect(cmdHelpHint('cli')).toContain('kb <command>')
  })
})

describe('CmdMode type', () => {
  it('[TC-94] accepts valid modes without type error', () => {
    const modes: CmdMode[] = ['cli', 'tui']
    expect(modes).toHaveLength(2)
  })
})
