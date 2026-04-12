import dayjs from 'dayjs'
import type { ToolExecutor } from '../core/tool-registry'
import { assertConsumerSafeCommand } from '../intents/policy'
import { DefaultIntentRouter } from '../intents/router'
import type { ConsumerIntent, ConsumerIntentEnvelope, IntentResult } from '../intents/types'

export type CliOutputMode = 'human' | 'json'

export interface ParsedIntentCommand {
  envelope: ConsumerIntentEnvelope
  output: CliOutputMode
}

const INTENT_COMMANDS = new Set(['submit', 'validate', 'dispute', 'query', 'explain'])

export function isIntentCommand(command: string): boolean {
  return INTENT_COMMANDS.has(command)
}

export function parseIntentCommand(args: string[]): ParsedIntentCommand {
  const [command, ...rest] = args

  if (!command) {
    throw new Error('Intent command is required')
  }

  assertConsumerSafeCommand(command)

  const output = parseOutput(rest)

  switch (command) {
    case 'submit':
      return {
        envelope: {
          intent: 'submit_fact',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            fact: readPositional(rest, 0, 'submit requires a fact string'),
            domain: readOption(rest, '--domain'),
            source: readOption(rest, '--source'),
            targetDocumentId: readOption(rest, '--target'),
          },
        },
        output,
      }

    case 'validate':
      return {
        envelope: {
          intent: 'validate_fact',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            fact: readPositional(rest, 0, 'validate requires a fact string'),
            domain: readOption(rest, '--domain'),
          },
        },
        output,
      }

    case 'dispute': {
      const because = readOption(rest, '--because')
      if (!because) {
        throw new Error('dispute requires --because "<counter evidence>"')
      }
      return {
        envelope: {
          intent: 'dispute_fact',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            fact: readPositional(rest, 0, 'dispute requires a fact string'),
            because,
            domain: readOption(rest, '--domain'),
          },
        },
        output,
      }
    }

    case 'query':
      return {
        envelope: {
          intent: 'query_truth',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            query: readPositional(rest, 0, 'query requires a topic/query string'),
            limit: parseLimit(readOption(rest, '--limit')),
            type: readOption(rest, '--type'),
          },
        },
        output,
      }

    case 'explain':
      return {
        envelope: {
          intent: 'explain_change',
          requestId: `req-${dayjs().valueOf()}`,
          payload: {
            fact: readPositional(rest, 0, 'explain requires a change id or fact'),
          },
        },
        output,
      }

    default:
      throw new Error(`Unsupported intent command: ${command}`)
  }
}

export async function executeIntentCommand(
  parsed: ParsedIntentCommand,
  toolExecutor: ToolExecutor,
): Promise<IntentResult> {
  const router = new DefaultIntentRouter(toolExecutor)
  return router.execute(parsed.envelope)
}

export function formatIntentResult(result: IntentResult, output: CliOutputMode): string {
  if (output === 'json') {
    return JSON.stringify(result, null, 2)
  }

  const lines: string[] = []
  lines.push(`Status: ${result.status}`)
  if (typeof result.confidence === 'number') {
    lines.push(`Confidence: ${result.confidence.toFixed(2)}`)
  }
  if (result.explanation) {
    lines.push(`Why: ${result.explanation}`)
  }
  if (result.recommendedAction) {
    lines.push(`Next: ${result.recommendedAction}`)
  }
  if (result.provenance?.length) {
    lines.push(`Provenance: ${result.provenance.join(', ')}`)
  }

  const data = result.data as { results?: Array<{ metadata?: { id?: string } }> } | undefined
  const results = data?.results
  if (Array.isArray(results)) {
    lines.push(`Matches: ${results.length}`)
    if (results.length > 0) {
      const ids = results
        .map(item => item.metadata?.id)
        .filter(Boolean)
        .slice(0, 5) as string[]
      if (ids.length > 0) {
        lines.push(`Match IDs: ${ids.join(', ')}`)
      }
    }
  }

  return lines.join('\n')
}

export function printIntentHelp(): string {
  return [
    'Intent commands:',
    '  kb submit "<fact>" [--domain ops] [--source runbook] [--target doc-id] [--output human|json]',
    '  kb validate "<fact>" [--domain ops] [--output human|json]',
    '  kb dispute "<fact>" --because "<counter evidence>" [--domain ops] [--output human|json]',
    '  kb query "<topic>" [--limit 5] [--type decision] [--output human|json]',
    '  kb explain "<change id|fact>" [--output human|json]',
  ].join('\n')
}

function parseOutput(args: string[]): CliOutputMode {
  const value = readOption(args, '--output')
  if (!value) return 'human'
  if (value === 'human' || value === 'json') return value
  throw new Error('--output must be one of: human, json')
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error('--limit must be a positive integer')
  }
  return parsed
}

function readPositional(args: string[], index: number, errorMessage: string): string {
  const positional = args.filter(arg => !arg.startsWith('--'))
  const value = positional[index]
  if (!value) {
    throw new Error(errorMessage)
  }
  return value
}

function readOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

export function toIntentName(command: string): ConsumerIntent {
  switch (command) {
    case 'submit':
      return 'submit_fact'
    case 'validate':
      return 'validate_fact'
    case 'dispute':
      return 'dispute_fact'
    case 'query':
      return 'query_truth'
    case 'explain':
      return 'explain_change'
    default:
      throw new Error(`Unsupported command: ${command}`)
  }
}
