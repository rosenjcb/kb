import type { SlashInputContext } from '@kb/core/ui/slash-context.js'
import { catalogSlashSpecs } from '@kb/core/commands/command-catalog.js'

export type { SlashInputContext } from '@kb/core/ui/slash-context.js'

export interface SlashCommandSpec {
  /** ['facts','list'] → '/facts list' */
  path: string[]
  description: string
  /** Where eligible. 'always' = available in every context (e.g. /exit, /cancel). */
  contexts: SlashInputContext[] | 'always'
}

export interface SlashCommand {
  command: string
  description: string
}

/**
 * The slash registry is generated from the shared command catalog
 * (`@kb/core/commands/command-catalog`) so the TUI can never drift from the CLI:
 * a command added to the catalog appears here automatically, and the parity test
 * (`tests/commands/command-parity.test.ts`) fails if the two disagree.
 *
 * Only genuinely flow-local commands — ones with no top-level catalog entry — are
 * appended by hand. Today that is just `/cancel`, which `kb init` honors at its
 * free-text prompts, so it is offered only in those input contexts (never at idle).
 */
export const SLASH_COMMAND_REGISTRY: SlashCommandSpec[] = [
  ...catalogSlashSpecs(),
  {
    path: ['cancel'],
    description: 'cancel the current flow',
    contexts: ['init-free-text', 'scan-base-picker'],
  },
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
