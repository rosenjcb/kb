import { MarkdownDocumentReader, type QueryResult } from '../tools/markdown-document-reader'
import { ensureOperationalBaseDir, resolveEffectiveBaseDir } from './base-selection'
import { type CmdMode, cmd } from './cmd-ref'

export type ViewOutputMode = 'human' | 'json'

export interface ParsedViewCommand {
  selector:
    | { mode: 'id'; value: string }
    | { mode: 'title'; value: string }
  output: ViewOutputMode
  base?: string
}

export interface ViewCommandResult {
  output: string
}

export interface ParsedListCommand {
  output: ViewOutputMode
  base?: string
  limit: number
}

export class ViewCommandError extends Error {
  exitCode: number

  constructor(message: string, exitCode: number = 1) {
    super(message)
    this.name = 'ViewCommandError'
    this.exitCode = exitCode
  }
}

export function printViewHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs view', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('docs view <document-id> [--base <name>] [--output human|json]', mode)}`,
    `  ${cmd('docs view --title "<exact title>" [--base <name>] [--output human|json]', mode)}`,
    '',
    'Examples:',
    `  ${cmd('docs view kb-base-selection-and-usage', mode)}`,
    `  ${cmd('docs view --title "KB Base Selection and Usage"', mode)}`,
    `  ${cmd('docs view kb-base-selection-and-usage --output json', mode)}`,
  ].join('\n')
}

export function printListHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs list', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('docs list [--base <name>] [--limit <n>] [--output human|json]', mode)}`,
    '',
    'Examples:',
    `  ${cmd('docs list', mode)}`,
    `  ${cmd('docs list --base dogfood --limit 20', mode)}`,
    `  ${cmd('docs list --output json', mode)}`,
  ].join('\n')
}

export async function runViewCommand(
  args: string[],
  options: { cwd?: string } = {},
): Promise<ViewCommandResult> {
  const parsed = parseViewCommand(args)
  const cwd = options.cwd ?? process.cwd()

  const baseDir = parsed.base
    ? await ensureOperationalBaseDir(parsed.base, cwd)
    : (await resolveEffectiveBaseDir(cwd)).baseDir

  const reader = new MarkdownDocumentReader(baseDir)
  const document = parsed.selector.mode === 'id'
    ? await readDocumentById(reader, parsed.selector.value)
    : await readDocumentByTitle(reader, parsed.selector.value)

  return {
    output: parsed.output === 'json'
      ? formatViewJson(document)
      : formatViewHuman(document, parsed.base),
  }
}

export async function runListCommand(
  args: string[],
  options: { cwd?: string } = {},
): Promise<ViewCommandResult> {
  const parsed = parseListCommand(args)
  const cwd = options.cwd ?? process.cwd()
  const baseDir = parsed.base
    ? await ensureOperationalBaseDir(parsed.base, cwd)
    : (await resolveEffectiveBaseDir(cwd)).baseDir

  const reader = new MarkdownDocumentReader(baseDir)
  const response = await reader.queryDocuments({
    limit: parsed.limit,
  })

  return {
    output: parsed.output === 'json'
      ? formatListJson(response.results)
      : formatListHuman(response.results, parsed.base),
  }
}

export function parseViewCommand(args: string[]): ParsedViewCommand {
  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new ViewCommandError(printViewHelp(), 0)
  }

  let title: string | undefined
  let base: string | undefined
  let output: ViewOutputMode = 'human'
  const positional: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]

    if (token === '--title') {
      title = readRequiredValue(args, index, '--title')
      index += 1
      continue
    }

    if (token === '--base') {
      base = readRequiredValue(args, index, '--base')
      index += 1
      continue
    }

    if (token === '--output') {
      const value = readRequiredValue(args, index, '--output')
      if (value !== 'human' && value !== 'json') {
        throw new ViewCommandError(`Unsupported output mode: ${value}. Use human or json.`)
      }
      output = value
      index += 1
      continue
    }

    if (token.startsWith('--')) {
      throw new ViewCommandError(`Unknown option: ${token}\n\n${printViewHelp()}`)
    }

    positional.push(token)
  }

  if (title && positional.length > 0) {
    throw new ViewCommandError('kb docs view accepts either <document-id> or --title, not both.')
  }

  if (!title && positional.length === 0) {
    throw new ViewCommandError(printViewHelp())
  }

  if (positional.length > 1) {
    throw new ViewCommandError('kb docs view accepts a single <document-id>.')
  }

  return {
    selector: title
      ? { mode: 'title', value: title }
      : { mode: 'id', value: sanitizeId(positional[0]) },
    output,
    base,
  }
}

export function parseListCommand(args: string[]): ParsedListCommand {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new ViewCommandError(printListHelp(), 0)
  }

  let base: string | undefined
  let output: ViewOutputMode = 'human'
  let limit = 20

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]

    if (token === '--base') {
      base = readRequiredValue(args, index, '--base')
      index += 1
      continue
    }

    if (token === '--output') {
      const value = readRequiredValue(args, index, '--output')
      if (value !== 'human' && value !== 'json') {
        throw new ViewCommandError(`Unsupported output mode: ${value}. Use human or json.`)
      }
      output = value
      index += 1
      continue
    }

    if (token === '--limit') {
      const value = readRequiredValue(args, index, '--limit')
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ViewCommandError(`--limit must be a positive integer. Received: ${value}`)
      }
      limit = parsed
      index += 1
      continue
    }

    throw new ViewCommandError(`kb docs list does not accept positional arguments.\n\n${printListHelp()}`)
  }

  return { output, base, limit }
}

async function readDocumentById(
  reader: MarkdownDocumentReader,
  documentId: string,
): Promise<QueryResult> {
  const response = await reader.queryDocuments({
    query: documentId,
    mode: 'id',
    limit: 1,
    includeContent: true,
  })

  const document = response.results[0]
  if (!document) {
    throw new ViewCommandError(`Document not found: ${documentId}`)
  }

  return document
}

async function readDocumentByTitle(
  reader: MarkdownDocumentReader,
  title: string,
): Promise<QueryResult> {
  const response = await reader.queryDocuments({
    query: title,
    mode: 'title',
    limit: 50,
    includeContent: true,
  })

  const exactMatches = response.results.filter(result =>
    normalizeTitle(result.metadata.title) === normalizeTitle(title),
  )

  if (exactMatches.length === 0) {
    throw new ViewCommandError(`Document not found: ${title}`)
  }

  if (exactMatches.length > 1) {
    const candidates = exactMatches
      .map(result => `- ${result.metadata.id} (${result.metadata.title})`)
      .join('\n')
    throw new ViewCommandError(`Ambiguous title match: ${title}\n${candidates}`, 2)
  }

  return exactMatches[0]
}

function formatViewHuman(document: QueryResult, base?: string): string {
  const lines = [
    `# ${document.metadata.title}`,
    `ID: ${document.metadata.id}`,
  ]

  if (document.metadata.type) {
    lines.push(`Type: ${document.metadata.type}`)
  }

  if (document.metadata.tags?.length) {
    lines.push(`Tags: ${document.metadata.tags.join(', ')}`)
  }

  lines.push(`Created: ${document.metadata.createdAt}`)
  lines.push(`Updated: ${document.metadata.updatedAt}`)

  if (base) {
    lines.push(`Base: ${base}`)
  }

  lines.push('')

  return `${lines.join('\n')}\n${stripCanonicalDocumentPreamble(document.content ?? '')}`
}

function formatViewJson(document: QueryResult): string {
  return `${JSON.stringify({ document }, null, 2)}\n`
}

function formatListHuman(documents: QueryResult[], base?: string): string {
  const lines = ['# KB Documents']

  if (base) {
    lines.push(`Base: ${base}`)
  }

  lines.push(`Count: ${documents.length}`, '')

  if (documents.length === 0) {
    lines.push('No documents found.')
    return `${lines.join('\n')}\n`
  }

  for (const document of documents) {
    const detailParts = [
      `title="${document.metadata.title}"`,
      document.metadata.type ? `type=${document.metadata.type}` : undefined,
      document.metadata.tags?.length ? `tags=${document.metadata.tags.join(',')}` : undefined,
      `updated=${document.metadata.updatedAt}`,
    ].filter(Boolean)

    lines.push(`- ${document.metadata.id} (${detailParts.join('; ')})`)
  }

  return `${lines.join('\n')}\n`
}

function formatListJson(documents: QueryResult[]): string {
  return `${JSON.stringify({ documents: documents.map(document => document.metadata) }, null, 2)}\n`
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document'
}

function stripCanonicalDocumentPreamble(content: string): string {
  if (!content.startsWith('# ')) {
    return content
  }

  const lines = content.split('\n')
  let index = 1

  while (index < lines.length && lines[index].trim() === '') {
    index += 1
  }

  while (index < lines.length && isCanonicalMetadataLine(lines[index])) {
    index += 1
  }

  while (index < lines.length && lines[index].trim() === '') {
    index += 1
  }

  return lines.slice(index).join('\n')
}

function isCanonicalMetadataLine(line: string): boolean {
  return (
    line.startsWith('Created:')
    || line.startsWith('Type:')
    || line.startsWith('Tags:')
  )
}

function readRequiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new ViewCommandError(`${flag} requires a value`)
  }
  return value
}
