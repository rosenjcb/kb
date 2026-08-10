import { describe, expect, it } from 'vitest'
import {
  COMMAND_CATALOG,
  cliHelpCommands,
  isOutputCommandName,
} from '@kb/core/commands/command-catalog.js'
import { SLASH_COMMAND_REGISTRY } from '@kb/client/tui/slash-command-registry.js'

/**
 * Anti-drift guard for the CLI/TUI command surface.
 *
 * The historical bug: `entities` and `session` were registered as TUI slash commands
 * but missing from the TUI output-dispatch gate, so typing them silently fell through
 * to the chat LLM. The fix made the shared command catalog
 * (`@kb/core/commands/command-catalog`) the single source of truth that BOTH surfaces
 * derive from. These tests fail if a command is ever added to one surface without the
 * other, or if the catalog and the generated slash registry disagree.
 */
describe('command catalog ↔ TUI slash registry parity', () => {
  const topLevelRegistry = SLASH_COMMAND_REGISTRY.filter(s => s.path.length === 1)
  // `cancel` is the one genuinely flow-local command with no catalog entry.
  const FLOW_LOCAL_ONLY = new Set(['cancel'])

  it('registers every catalog command that has a TUI presence', () => {
    for (const c of COMMAND_CATALOG) {
      if (c.tuiKind === 'none') continue
      const entry = topLevelRegistry.find(s => s.path[0] === c.name)
      expect(entry, `catalog command "${c.name}" missing from slash registry`).toBeDefined()
    }
  })

  it('has no slash command that is absent from the catalog', () => {
    for (const spec of topLevelRegistry) {
      const name = spec.path[0]
      if (FLOW_LOCAL_ONLY.has(name)) continue
      const inCatalog = COMMAND_CATALOG.some(c => c.name === name && c.tuiKind !== 'none')
      expect(inCatalog, `slash command "/${name}" is not a TUI-visible catalog command`).toBe(true)
    }
  })

  it('registers every catalog subcommand', () => {
    for (const c of COMMAND_CATALOG) {
      if (c.tuiKind === 'none') continue
      for (const sub of c.subcommands ?? []) {
        const entry = SLASH_COMMAND_REGISTRY.find(
          s => s.path.length === 2 && s.path[0] === c.name && s.path[1] === sub.name
        )
        expect(entry, `subcommand "/${c.name} ${sub.name}" missing from slash registry`).toBeDefined()
      }
    }
  })

  it('keeps isOutputCommandName aligned with the catalog tuiKind (the entities/session bug)', () => {
    for (const c of COMMAND_CATALOG) {
      expect(isOutputCommandName(c.name), `${c.name} output-gate mismatch`).toBe(c.tuiKind === 'output')
    }
    // entities and session must both be output commands, or the TUI silently drops them.
    expect(isOutputCommandName('entities')).toBe(true)
    expect(isOutputCommandName('session')).toBe(true)
    // help has no bespoke TUI handler, so it must route through the output runner (which
    // renders the CLI help in-process) rather than being marked `local` and hitting chat.
    expect(isOutputCommandName('help')).toBe(true)
  })

  it('exposes each cliHelp command exactly once', () => {
    const names = cliHelpCommands().map(c => c.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('query')
    expect(names).toContain('session')
  })

  it('does not resurrect the removed docs command', () => {
    expect(COMMAND_CATALOG.some(c => c.name === 'docs')).toBe(false)
    expect(SLASH_COMMAND_REGISTRY.some(s => s.path[0] === 'docs')).toBe(false)
    expect(isOutputCommandName('docs')).toBe(false)
  })

  it('only uses live slash-input contexts', () => {
    const LIVE = new Set(['idle', 'init-free-text', 'scan-base-picker'])
    for (const spec of SLASH_COMMAND_REGISTRY) {
      if (spec.contexts === 'always') continue
      for (const ctx of spec.contexts) {
        expect(LIVE.has(ctx), `stale slash context "${ctx}" in /${spec.path.join(' ')}`).toBe(true)
      }
    }
  })
})
