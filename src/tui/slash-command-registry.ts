export type SlashInputContext =
  | 'idle'
  | 'docs-generate-question'
  | 'docs-generate-review'
  | 'init-category-confirm'
  | 'init-free-text'
  | 'init-question'

export interface SlashCommandSpec {
  /** ['docs','generate'] → '/docs generate' */
  path: string[]
  description: string
  /** Where eligible. 'always' = available in every context (e.g. /exit, /cancel). */
  contexts: SlashInputContext[] | 'always'
}

export interface SlashCommand {
  command: string
  description: string
}

export const SLASH_COMMAND_REGISTRY: SlashCommandSpec[] = [
  // Top-level
  { path: ['query'], description: 'search the knowledge base', contexts: ['idle'] },
  { path: ['submit'], description: 'store a new fact or checkpoint', contexts: ['idle'] },
  { path: ['invalidate'], description: 'remove or replace stale KB facts', contexts: ['idle'] },
  { path: ['init'], description: 'build a knowledge base from this repo', contexts: ['idle'] },
  { path: ['scan'], description: 'scan this repo into the active or selected KB base', contexts: ['idle'] },
  { path: ['base'], description: 'manage KB bases (use, delete)', contexts: ['idle'] },
  { path: ['docs'], description: 'browse or generate KB documents', contexts: ['idle'] },
  { path: ['facts'], description: 'list, search, or show KB facts', contexts: ['idle'] },
  { path: ['graph'], description: 'inspect or edit the knowledge graph', contexts: ['idle'] },
  { path: ['publish'], description: 'publish docs to the external sink', contexts: ['idle'] },
  { path: ['sync'], description: 'install the latest published KB release', contexts: ['idle'] },
  { path: ['skills'], description: 'manage agent skills', contexts: ['idle'] },
  { path: ['config'], description: 'inspect or update config values', contexts: ['idle'] },
  { path: ['logs'], description: 'browse and compare run reports', contexts: ['idle'] },
  { path: ['session'], description: 'show session stats (turns, tokens, facts, timing)', contexts: ['idle'] },
  { path: ['help'], description: 'show available commands', contexts: ['idle'] },
  { path: ['clear'], description: 'clear the visible session history', contexts: ['idle'] },
  { path: ['exit'], description: 'quit kb', contexts: 'always' },

  // docs subcommands
  { path: ['docs', 'list'], description: 'list KB documents', contexts: ['idle'] },
  { path: ['docs', 'view'], description: 'view a KB document by id', contexts: ['idle'] },
  { path: ['docs', 'generate'], description: 'guided document draft (questionnaire + review)', contexts: ['idle'] },
  { path: ['docs', 'rename'], description: 'rename a KB document', contexts: ['idle'] },
  { path: ['docs', 'delete'], description: 'delete a KB document', contexts: ['idle'] },

  // facts subcommands
  { path: ['facts', 'list'], description: 'list KB facts', contexts: ['idle'] },
  { path: ['facts', 'search'], description: 'search KB facts', contexts: ['idle'] },
  { path: ['facts', 'show'], description: 'show a KB fact by id or text', contexts: ['idle'] },

  // base subcommands
  { path: ['base', 'use'], description: 'switch active KB base', contexts: ['idle'] },
  { path: ['base', 'delete'], description: 'delete a KB base', contexts: ['idle'] },

  // logs subcommands
  { path: ['logs', 'list'], description: 'list run reports', contexts: ['idle'] },
  { path: ['logs', 'show'], description: 'show a run report by id', contexts: ['idle'] },
  { path: ['logs', 'compare'], description: 'compare run reports', contexts: ['idle'] },

  // skills subcommands
  { path: ['skills', 'install'], description: 'install an agent skill', contexts: ['idle'] },
  { path: ['skills', 'uninstall'], description: 'uninstall an agent skill', contexts: ['idle'] },

  // Flow-local commands
  { path: ['skip'], description: 'skip the current question', contexts: ['docs-generate-question', 'init-question'] },
  { path: ['cancel'], description: 'cancel the current flow', contexts: 'always' },
  { path: ['accept'], description: 'accept draft or categories', contexts: ['docs-generate-review', 'init-category-confirm'] },
  { path: ['reject'], description: 'reject with feedback', contexts: ['docs-generate-review', 'init-category-confirm'] },
]

function specToSlashCommand(spec: SlashCommandSpec): SlashCommand {
  return {
    command: `/${spec.path.join(' ')}`,
    description: spec.description,
  }
}

function isEligible(spec: SlashCommandSpec, context: SlashInputContext): boolean {
  if (spec.contexts === 'always') return true
  if (context === 'idle') return spec.contexts.includes('idle')
  return spec.contexts.includes(context)
}

export function parseSlashInput(input: string): { segments: string[]; hasTrailingArgs: boolean } {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return { segments: [], hasTrailingArgs: false }

  const tokens: string[] = []
  let hasTrailingArgs = false

  for (const token of trimmed.slice(1).split(/\s+/)) {
    if (!token) continue
    if (token.startsWith('--') || token.includes('"') || token.includes("'")) {
      hasTrailingArgs = true
      break
    }
    tokens.push(token)
  }

  return { segments: tokens, hasTrailingArgs }
}

function pathPrefixMatches(specPath: string[], typedSegments: string[]): boolean {
  if (typedSegments.length > specPath.length) return false

  for (let i = 0; i < typedSegments.length; i += 1) {
    const typed = typedSegments[i]?.toLowerCase() ?? ''
    const spec = specPath[i]?.toLowerCase() ?? ''
    if (!spec.startsWith(typed)) return false
  }

  return true
}

function compareSpecs(a: SlashCommandSpec, b: SlashCommandSpec): number {
  if (a.path.length !== b.path.length) return a.path.length - b.path.length
  return a.path.join(' ').localeCompare(b.path.join(' '))
}

export function resolveSlashSuggestions(
  input: string,
  context: SlashInputContext = 'idle'
): SlashCommand[] {
  if (!input.startsWith('/')) return []

  const { segments, hasTrailingArgs } = parseSlashInput(input)
  if (hasTrailingArgs) return []

  const eligible = SLASH_COMMAND_REGISTRY.filter(spec => isEligible(spec, context))
  const matching = eligible.filter(spec => pathPrefixMatches(spec.path, segments))

  if (segments.length === 0) {
    return matching
      .filter(spec => spec.path.length === 1)
      .map(specToSlashCommand)
      .sort((a, b) => a.command.localeCompare(b.command))
  }

  return matching.map(specToSlashCommand).sort((a, b) => {
    const specA = eligible.find(spec => `/${spec.path.join(' ')}` === a.command)
    const specB = eligible.find(spec => `/${spec.path.join(' ')}` === b.command)
    if (!specA || !specB) return a.command.localeCompare(b.command)
    return compareSpecs(specA, specB)
  })
}

export function getSlashCommandsForContext(context: SlashInputContext = 'idle'): SlashCommand[] {
  return SLASH_COMMAND_REGISTRY.filter(
    spec => spec.path.length === 1 && isEligible(spec, context)
  )
    .map(specToSlashCommand)
    .sort((a, b) => a.command.localeCompare(b.command))
}
