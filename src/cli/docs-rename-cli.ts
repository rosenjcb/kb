import path from 'node:path'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { type CmdMode, cmd } from './cmd-ref'
import type { CliOutput } from './index'

export interface ParsedDocsRenameCommand {
  documentId: string
  newTitle: string
  base?: string
}

export class DocsRenameError extends Error {
  exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'DocsRenameError'
    this.exitCode = exitCode
  }
}

export function printDocsRenameHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs rename', mode)} — rename a document`,
    '',
    'Usage:',
    `  ${cmd('docs rename <documentId> "<new title>" [--base <name>]', mode)}`,
    '',
    'The document ID stays the same; only the title is updated.',
    '',
    'Examples:',
    `  ${cmd('docs rename general-facts "Core Facts"', mode)}`,
    `  ${cmd('docs rename kb-overview "KB System Overview" --base dogfood', mode)}`,
  ].join('\n')
}

export function parseDocsRenameCommand(args: string[]): ParsedDocsRenameCommand {
  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new DocsRenameError(printDocsRenameHelp(), 0)
  }

  let base: string | undefined
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--base') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        throw new DocsRenameError('--base requires a value')
      }
      base = value
      i++
      continue
    }
    if (token.startsWith('--')) {
      throw new DocsRenameError(`Unknown option: ${token}\n\n${printDocsRenameHelp()}`)
    }
    positional.push(token)
  }

  if (positional.length < 2) {
    throw new DocsRenameError(
      `docs rename requires a document id and a new title.\n\n${printDocsRenameHelp()}`
    )
  }

  if (positional.length > 2) {
    throw new DocsRenameError(
      `docs rename accepts exactly two positional arguments. Wrap the new title in quotes if it contains spaces.\n\n${printDocsRenameHelp()}`
    )
  }

  const newTitle = positional[1].trim()
  if (!newTitle) {
    throw new DocsRenameError('New title cannot be empty.')
  }

  return {
    documentId: sanitizeId(positional[0]),
    newTitle,
    base,
  }
}

export async function runDocsRename(
  parsed: ParsedDocsRenameCommand,
  baseDir: string,
  out: CliOutput
): Promise<void> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })
  const writer = new SqliteDocumentWriter({ baseDir })
  try {
    const existing = indexer.getDocumentContent(parsed.documentId)
    if (!existing) {
      throw new DocsRenameError(`Document not found: ${parsed.documentId}`)
    }

    const oldTitle = extractTitle(existing)
    const body = stripPreamble(existing)

    await writer.updateDocument({
      documentId: parsed.documentId,
      title: parsed.newTitle,
      content: body,
    })

    out.log(`Renamed "${oldTitle}" → "${parsed.newTitle}" (id: ${parsed.documentId})`)
  } finally {
    writer.close()
    indexer.close()
  }
}

function sanitizeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'document'
  )
}

function extractTitle(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  return firstLine.startsWith('# ') ? firstLine.slice(2).trim() : 'Untitled'
}

function stripPreamble(content: string): string {
  if (!content.startsWith('# ')) return content
  const lines = content.split('\n')
  let i = 1
  while (i < lines.length && lines[i].trim() === '') i++
  while (
    i < lines.length &&
    (lines[i].startsWith('Created:') ||
      lines[i].startsWith('Type:') ||
      lines[i].startsWith('Tags:'))
  )
    i++
  while (i < lines.length && lines[i].trim() === '') i++
  return lines.slice(i).join('\n')
}
