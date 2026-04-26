import path from 'node:path'
import { createInterface } from 'node:readline'
import type { LLMProvider } from '../core/types'
import { classifyDocumentLane } from '../tools/retrieval-lane-router'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'
import { type CmdMode, cmd } from './cmd-ref'
import type { CliOutput } from './index'

export interface ParsedDocsMergeCommand {
  targetDocId: string
  sourceDocIds: string[]
  base?: string
}

export class DocsMergeError extends Error {
  exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'DocsMergeError'
    this.exitCode = exitCode
  }
}

export function printDocsMergeHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs merge', mode)} — merge multiple documents into one`,
    '',
    'Usage:',
    `  ${cmd('docs merge <targetDocId> <sourceDocId> [<sourceDocId>...] [--base <name>]', mode)}`,
    '',
    'The target document is updated with merged content.',
    'Source documents are deleted after a successful merge.',
    '',
    'Examples:',
    `  ${cmd('docs merge general-facts retrieval-facts security-facts', mode)}`,
    `  ${cmd('docs merge kb-overview old-overview --base dogfood', mode)}`,
  ].join('\n')
}

export function parseDocsMergeCommand(args: string[]): ParsedDocsMergeCommand {
  if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    throw new DocsMergeError(printDocsMergeHelp(), 0)
  }

  let base: string | undefined
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--base') {
      const value = args[i + 1]
      if (!value || value.startsWith('--')) {
        throw new DocsMergeError('--base requires a value')
      }
      base = value
      i++
      continue
    }
    if (token.startsWith('--')) {
      throw new DocsMergeError(`Unknown option: ${token}\n\n${printDocsMergeHelp()}`)
    }
    positional.push(token)
  }

  if (positional.length < 2) {
    throw new DocsMergeError(
      `docs merge requires a target and at least one source document.\n\n${printDocsMergeHelp()}`
    )
  }

  return {
    targetDocId: sanitizeId(positional[0]),
    sourceDocIds: positional.slice(1).map(sanitizeId),
    base,
  }
}

export async function runDocsMerge(
  parsed: ParsedDocsMergeCommand,
  baseDir: string,
  _llmProvider: LLMProvider,
  out: CliOutput
): Promise<void> {
  const dbPath = path.join(baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })

  const targetContent = indexer.getDocumentContent(parsed.targetDocId)
  if (!targetContent) {
    throw new DocsMergeError(`Target document not found: ${parsed.targetDocId}`)
  }

  const sourceDocs: Array<{ id: string; content: string }> = []
  for (const sourceId of parsed.sourceDocIds) {
    const content = indexer.getDocumentContent(sourceId)
    if (!content) {
      throw new DocsMergeError(`Source document not found: ${sourceId}`)
    }
    sourceDocs.push({ id: sourceId, content })
  }

  const targetTitle = extractTitle(targetContent)
  const userInstructions = await promptForInstructions()

  out.log(
    `\nMerging ${sourceDocs.length} source doc(s) into "${targetTitle}" (${parsed.targetDocId})...`
  )

  const mergedBody = deterministicMergeBodies({
    targetBody: stripPreamble(targetContent),
    sourceBodies: sourceDocs.map(doc => stripPreamble(doc.content)),
    userInstructions,
  })
  if (!mergedBody) {
    throw new DocsMergeError('Deterministic merge produced empty content')
  }

  const existingMeta = extractMeta(targetContent)
  const now = new Date().toISOString()
  const metaLines = [
    `Created: ${existingMeta.createdAt}`,
    ...(existingMeta.type ? [`Type: ${existingMeta.type}`] : []),
    ...(existingMeta.tags.length ? [`Tags: ${existingMeta.tags.join(', ')}`] : []),
  ]
  const newContent = `# ${targetTitle}\n\n${metaLines.join('\n')}\n\n${mergedBody}\n`

  indexer.upsertDocumentWithContent({
    id: parsed.targetDocId,
    title: targetTitle,
    content: newContent,
    docType: existingMeta.type,
    lane: classifyDocumentLane(
      parsed.targetDocId,
      targetTitle,
      existingMeta.type,
      existingMeta.tags,
      ''
    ),
    tags: existingMeta.tags,
    createdAt: existingMeta.createdAt || now,
  })

  for (const { id } of sourceDocs) {
    indexer.removeDocument(id)
    out.log(`  ✓ Deleted source: ${id}`)
  }

  out.log(`  ✓ Updated target: ${parsed.targetDocId}`)
  out.log('\nMerge complete.')
}

function deterministicMergeBodies(input: {
  targetBody: string
  sourceBodies: string[]
  userInstructions: string
}): string {
  const blocks: string[] = []
  const seen = new Set<string>()

  const appendBlock = (raw: string) => {
    const cleaned = sanitizeBlock(raw)
    if (!cleaned) return
    const key = canonicalizeBlock(cleaned)
    if (!key || seen.has(key)) return
    seen.add(key)
    blocks.push(cleaned)
  }

  splitIntoBlocks(input.targetBody).forEach(appendBlock)
  input.sourceBodies.flatMap(splitIntoBlocks).forEach(appendBlock)

  if (input.userInstructions.trim()) {
    appendBlock(`Merge note: ${input.userInstructions.trim()}`)
  }

  return blocks.join('\n\n').trim()
}

function splitIntoBlocks(content: string): string[] {
  return content
    .split(/\n\s*\n/g)
    .map(block => block.trim())
    .filter(Boolean)
}

function sanitizeBlock(block: string): string {
  return block
    .replace(/^\s*#+\s+/gm, '')
    .replace(/^\s*(Created:|Type:|Tags:).*/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function canonicalizeBlock(block: string): string {
  return block
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function promptForInstructions(): Promise<string> {
  if (!process.stdin.isTTY) return ''

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question('Any details or instructions for the merge? (press Enter to skip): ', answer => {
      rl.close()
      resolve(answer.trim())
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

interface DocMeta {
  createdAt: string
  type: string | null
  tags: string[]
}

function extractMeta(content: string): DocMeta {
  let createdAt = new Date().toISOString()
  let type: string | null = null
  let tags: string[] = []
  for (const line of content.split('\n').slice(0, 15)) {
    if (line.startsWith('Created:')) createdAt = line.slice('Created:'.length).trim()
    else if (line.startsWith('Type:')) type = line.slice('Type:'.length).trim() || null
    else if (line.startsWith('Tags:'))
      tags = line
        .slice('Tags:'.length)
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
  }
  return { createdAt, type, tags }
}
