import path from 'node:path'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import type { CliOutput } from './index'
import { type CmdMode, cmd } from './cmd-ref'

export interface ParsedDocsDeleteCommand {
  documentId: string
  base?: string
  force: boolean
}

export class DocsDeleteError extends Error {
  exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'DocsDeleteError'
    this.exitCode = exitCode
  }
}

export function printDocsDeleteHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs delete', mode)} — delete a document`,
    '',
    'Usage:',
    `  ${cmd('docs delete <documentId> [--base <name>] [--force]', mode)}`,
    '',
    'Prompts for confirmation unless --force is passed.',
    '',
    'Examples:',
    `  ${cmd('docs delete general-facts', mode)}`,
    `  ${cmd('docs delete old-overview --base dogfood --force', mode)}`,
  ].join('\n')
}

export function parseDocsDeleteCommand(args: string[]): ParsedDocsDeleteCommand {
  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new DocsDeleteError(printDocsDeleteHelp(), 0)
  }

  let base: string | undefined
  let force = false
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--base') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        throw new DocsDeleteError('--base requires a value')
      }
      base = value
      i++
      continue
    }
    if (token === '--force' || token === '-f') {
      force = true
      continue
    }
    if (token.startsWith('--')) {
      throw new DocsDeleteError(`Unknown option: ${token}\n\n${printDocsDeleteHelp()}`)
    }
    positional.push(token)
  }

  if (positional.length === 0) {
    throw new DocsDeleteError(
      `docs delete requires a document id.\n\n${printDocsDeleteHelp()}`
    )
  }

  if (positional.length > 1) {
    throw new DocsDeleteError(
      `docs delete accepts exactly one document id.\n\n${printDocsDeleteHelp()}`
    )
  }

  return { documentId: sanitizeId(positional[0]), base, force }
}

export async function runDocsDelete(
  parsed: ParsedDocsDeleteCommand,
  baseDir: string,
  out: CliOutput
): Promise<void> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })

  const existing = indexer.getDocumentContent(parsed.documentId)
  if (!existing) {
    throw new DocsDeleteError(`Document not found: ${parsed.documentId}`)
  }

  const title = extractTitle(existing)

  if (!parsed.force) {
    const confirmed = await promptConfirm(
      `Delete "${title}" (${parsed.documentId})? This cannot be undone. [y/N]: `
    )
    if (!confirmed) {
      out.log('Aborted.')
      return
    }
  }

  indexer.removeDocument(parsed.documentId)
  out.log(`Deleted "${title}" (${parsed.documentId}).`)
}

async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false

  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
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
