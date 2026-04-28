import { ensureOperationalBaseDir, resolveEffectiveBaseDir } from './base-selection'
import { type CmdMode, cmd } from './cmd-ref'
import { createKBToolsRegistry } from '../tools/kb-tools-registry'

export interface ParsedDocsGenerateCommand {
  instruction: string
  title: string
  base?: string
  limit?: number
}

export class DocsGenerateError extends Error {
  exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'DocsGenerateError'
    this.exitCode = exitCode
  }
}

export function printDocsGenerateHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs generate', mode)} — generate derived markdown from facts`,
    '',
    'Usage:',
    `  ${cmd('docs generate "<instruction>" --title "<title>" [--limit <n>] [--base <name>]', mode)}`,
    '',
    'Examples:',
    `  ${cmd('docs generate "Create agent-loop explainer" --title "Agent Loop Overview"', mode)}`,
  ].join('\n')
}

export function parseDocsGenerateCommand(args: string[]): ParsedDocsGenerateCommand {
  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new DocsGenerateError(printDocsGenerateHelp(), 0)
  }

  const positional = args.filter(token => !token.startsWith('--'))
  const instruction = positional[0]?.trim()
  if (!instruction) {
    throw new DocsGenerateError(`docs generate requires an instruction.\n\n${printDocsGenerateHelp()}`)
  }
  const title = readRequiredOption(args, '--title')
  const limitRaw = readOption(args, '--limit')
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
  if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
    throw new DocsGenerateError('--limit must be a positive integer')
  }
  return {
    instruction,
    title,
    base: readOption(args, '--base'),
    limit,
  }
}

export async function runDocsGenerate(parsed: ParsedDocsGenerateCommand, cwd = process.cwd()) {
  const baseDir = parsed.base
    ? await ensureOperationalBaseDir(parsed.base, cwd)
    : (await resolveEffectiveBaseDir(cwd)).baseDir
  const tools = createKBToolsRegistry(baseDir)
  const response = await tools.execute({
    id: `docs-generate-${Date.now()}`,
    name: 'generate_document_from_facts',
    input: {
      instruction: parsed.instruction,
      title: parsed.title,
      limit: parsed.limit ?? 20,
    },
  })
  return response as { id: string; title: string; sourceFactCount: number }
}

function readOption(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  if (!value || value.startsWith('--')) {
    throw new DocsGenerateError(`${key} requires a value`)
  }
  return value
}

function readRequiredOption(args: string[], key: string): string {
  const value = readOption(args, key)
  if (!value?.trim()) {
    throw new DocsGenerateError(`${key} is required`)
  }
  return value.trim()
}
