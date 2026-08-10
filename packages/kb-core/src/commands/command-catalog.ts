import type { SlashInputContext } from '../ui/slash-context.js'

/**
 * Single source of truth for every top-level `kb` command.
 *
 * Both surfaces derive from this catalog instead of hand-maintaining parallel
 * lists — the TUI slash registry, the TUI output-only dispatch gate, and the CLI
 * `--help` listing are all generated from `COMMAND_CATALOG`. A command that is
 * added here appears on both surfaces at once; a command that is *not* here is
 * caught by the parity test (`tests/commands/command-parity.test.ts`). This is
 * what stops the CLI and TUI from drifting apart (the historical bug: `entities`
 * and `session` were registered as slash commands but missing from the TUI
 * dispatch gate, so they silently did nothing).
 */

/** Where a command's handler runs. */
export type CommandAvailability = 'client-local' | 'server-forwarded'

/**
 * How the TUI reacts to the command:
 *  - `output`      — run through the shared command runner and render its text output
 *  - `interactive` — needs a bespoke TUI flow (a confirmation prompt, etc.)
 *  - `chat`        — hand off to the chat/LLM turn (e.g. `query`)
 *  - `local`       — handled directly in the TUI shell, never forwarded (clear/exit)
 *  - `none`        — not offered as a TUI slash command (CLI-only)
 */
export type TuiKind = 'output' | 'interactive' | 'chat' | 'local' | 'none'

export interface SubcommandDescriptor {
  name: string
  summary: string
}

export interface CommandDescriptor {
  name: string
  summary: string
  availability: CommandAvailability
  subcommands?: SubcommandDescriptor[]
  /** TUI contexts the slash command is offered in. Empty ⇒ not a TUI slash command. */
  tuiContexts: SlashInputContext[] | 'always'
  tuiKind: TuiKind
  /** Whether it appears in the `kb --help` top-level command list. */
  cliHelp: boolean
}

export const COMMAND_CATALOG: CommandDescriptor[] = [
  {
    name: 'query',
    summary: 'search the knowledge base',
    availability: 'server-forwarded',
    tuiContexts: ['idle'],
    tuiKind: 'chat',
    cliHelp: true,
  },
  {
    name: 'base',
    summary: 'manage KB bases and their git repos',
    availability: 'client-local',
    subcommands: [{ name: 'use', summary: 'switch active KB base (client)' }],
    tuiContexts: ['idle'],
    tuiKind: 'output',
    cliHelp: true,
  },
  {
    name: 'facts',
    summary: 'list, search, or show KB facts',
    availability: 'server-forwarded',
    subcommands: [
      { name: 'list', summary: 'list KB facts' },
      { name: 'search', summary: 'search KB facts' },
      { name: 'show', summary: 'show a KB fact by id or text' },
    ],
    tuiContexts: ['idle'],
    tuiKind: 'output',
    cliHelp: true,
  },
  {
    name: 'graph',
    summary: 'inspect the document↔symbol map',
    availability: 'server-forwarded',
    tuiContexts: ['idle'],
    tuiKind: 'output',
    cliHelp: true,
  },
  {
    name: 'entities',
    summary: 'inspect harvested entities and name collisions',
    availability: 'server-forwarded',
    tuiContexts: ['idle'],
    tuiKind: 'output',
    cliHelp: true,
  },
  {
    name: 'logs',
    summary: 'browse and compare run reports',
    availability: 'server-forwarded',
    subcommands: [
      { name: 'list', summary: 'list run reports' },
      { name: 'show', summary: 'show a run report by id' },
      { name: 'compare', summary: 'compare run reports' },
    ],
    tuiContexts: ['idle'],
    tuiKind: 'output',
    cliHelp: true,
  },
  {
    name: 'session',
    summary: 'show the most recent chat session and its runs',
    // Session history lives with the server's run logs (~/.kb/logs), so the
    // command is forwarded and rendered server-side, same as `logs`.
    availability: 'server-forwarded',
    tuiContexts: ['idle'],
    tuiKind: 'output',
    cliHelp: true,
  },
  {
    name: 'skills',
    summary: 'show status of agent skills, or install/uninstall them',
    availability: 'client-local',
    subcommands: [
      { name: 'install', summary: 'install an agent skill' },
      { name: 'uninstall', summary: 'uninstall an agent skill' },
    ],
    tuiContexts: ['idle'],
    tuiKind: 'output',
    cliHelp: true,
  },
  {
    name: 'sync',
    summary: 'install the latest published KB release',
    availability: 'client-local',
    tuiContexts: ['idle'],
    tuiKind: 'output',
    cliHelp: true,
  },
  {
    name: 'mcp',
    summary: 'wire MCP for Claude / Cursor',
    availability: 'client-local',
    subcommands: [
      { name: 'install', summary: 'install MCP config' },
      { name: 'status', summary: 'show MCP wiring status' },
      { name: 'uninstall', summary: 'remove MCP config' },
    ],
    // CLI-only today: MCP wiring is not offered as a TUI slash command.
    tuiContexts: [],
    tuiKind: 'none',
    cliHelp: true,
  },
  {
    name: 'uninstall',
    summary: 'remove the kb client binary and client runtime',
    availability: 'client-local',
    tuiContexts: ['idle'],
    tuiKind: 'interactive',
    cliHelp: true,
  },
  {
    name: 'help',
    summary: 'show available commands',
    availability: 'client-local',
    tuiContexts: ['idle'],
    tuiKind: 'local',
    cliHelp: false,
  },
  {
    name: 'clear',
    summary: 'clear the visible session history',
    availability: 'client-local',
    tuiContexts: ['idle'],
    tuiKind: 'local',
    cliHelp: false,
  },
  {
    name: 'exit',
    summary: 'quit kb',
    availability: 'client-local',
    tuiContexts: 'always',
    tuiKind: 'local',
    cliHelp: false,
  },
]

/** Commands that the TUI runs through the shared command runner and renders as output. */
export function isOutputCommandName(name: string): boolean {
  return COMMAND_CATALOG.some(c => c.name === name && c.tuiKind === 'output')
}

/** Look up a catalog entry by top-level command name. */
export function findCommand(name: string): CommandDescriptor | undefined {
  return COMMAND_CATALOG.find(c => c.name === name)
}

/** One slash-command entry (top-level or subcommand) derived from the catalog. */
export interface CatalogSlashSpec {
  path: string[]
  description: string
  contexts: SlashInputContext[] | 'always'
}

/**
 * The TUI slash-command specs implied by the catalog: every command with a TUI
 * presence (`tuiKind !== 'none'`), plus one entry per subcommand. This is what the
 * TUI slash registry is built from, so a command added to the catalog appears in the
 * TUI automatically and can never silently drift.
 */
export function catalogSlashSpecs(): CatalogSlashSpec[] {
  const specs: CatalogSlashSpec[] = []
  for (const c of COMMAND_CATALOG) {
    if (c.tuiKind === 'none') continue
    specs.push({ path: [c.name], description: c.summary, contexts: c.tuiContexts })
    for (const sub of c.subcommands ?? []) {
      specs.push({ path: [c.name, sub.name], description: sub.summary, contexts: c.tuiContexts })
    }
  }
  return specs
}

/** A command shown in the `kb --help` top-level list. `intent` = free-text intent command (query). */
export interface CliHelpCommand {
  name: string
  summary: string
  intent: boolean
}

/** Top-level commands that appear in the client `kb --help` listing, derived from the catalog. */
export function cliHelpCommands(): CliHelpCommand[] {
  return COMMAND_CATALOG.filter(c => c.cliHelp).map(c => ({
    name: c.name,
    summary: c.summary,
    intent: c.tuiKind === 'chat',
  }))
}
