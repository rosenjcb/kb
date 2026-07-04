import path from 'node:path'
import { SqliteKbIndexer } from '@kb/core/tools/sqlite-kb-index.js'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import type { CliOutput } from './index'

export interface ParsedDocsDeleteCommand {
  documentId: string
  isWildcard: boolean
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
    `  ${cmd('docs delete <documentId|pattern> [--base <name>] [--force]', mode)}`,
    '',
    'Prompts for confirmation unless --force is passed.',
    'Use * as a wildcard to match and delete multiple documents.',
    '',
    'Examples:',
    `  ${cmd('docs delete general-facts', mode)}`,
    `  ${cmd('docs delete old-overview --base dogfood --force', mode)}`,
    `  ${cmd('docs delete ci-* --force', mode)}`,
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
    throw new DocsDeleteError(`docs delete requires a document id.\n\n${printDocsDeleteHelp()}`)
  }

  if (positional.length > 1) {
    throw new DocsDeleteError(
      `docs delete accepts exactly one document id.\n\n${printDocsDeleteHelp()}`
    )
  }

  const raw = positional[0]
  const isWildcard = raw.includes('*')
  const documentId = isWildcard ? sanitizeWildcardPattern(raw) : sanitizeId(raw)

  return { documentId, isWildcard, base, force }
}

export async function runDocsDelete(
  parsed: ParsedDocsDeleteCommand,
  baseDir: string,
  out: CliOutput
): Promise<void> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })

  if (parsed.isWildcard) {
    const allDocs = indexer.listAllDocs()
    const matches = allDocs.filter(d => matchesWildcard(parsed.documentId, d.id))

    if (matches.length === 0) {
      throw new DocsDeleteError(`No documents match pattern: ${parsed.documentId}`)
    }

    out.log(`Found ${matches.length} document(s) matching "${parsed.documentId}":`)
    for (const doc of matches) {
      out.log(`  ${doc.id} — ${doc.title}`)
    }

    if (!parsed.force) {
      const confirmed = await promptConfirm(
        `Delete ${matches.length} document(s)? This cannot be undone. [y/N]: `
      )
      if (!confirmed) {
        out.log('Aborted.')
        return
      }
    }

    for (const doc of matches) {
      indexer.removeDocument(doc.id)
      out.log(`Deleted "${doc.title}" (${doc.id}).`)
    }
    return
  }

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

function sanitizeWildcardPattern(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9*]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || '*'
  )
}

function matchesWildcard(pattern: string, id: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(id)
}

function extractTitle(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  return firstLine.startsWith('# ') ? firstLine.slice(2).trim() : 'Untitled'
}
