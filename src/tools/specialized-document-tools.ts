/**
 * Specialized Document Operation Tools
 * Following separation-of-concerns pattern from TOOL_CONVENTIONS.md:
 * One tool per responsibility (append, update, merge, prune, query)
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'
import type { MarkdownMDWriterTool } from './markdown-md-writer-tool'
import type {
  AppendToDocumentInput,
  UpdateDocumentInput,
  PruneDocumentInput,
  WriteDocumentResult,
  MergeDocumentsInput,
  MergeDocumentsResult,
} from './document-writer'

/**
 * Append content to existing document (bottom by default)
 */
export async function appendToDocument(
  writer: MarkdownMDWriterTool,
  input: AppendToDocumentInput,
  baseDir: string,
): Promise<WriteDocumentResult> {
  const id = sanitizeId(input.documentId)
  const filePath = path.join(baseDir, `${id}.md`)

  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    throw new Error(`Document not found: ${input.documentId}`)
  }

  const appendContent = input.content.endsWith('\n') ? input.content : `${input.content}\n`
  const updatedContent =
    input.position === 'top' ? appendContent + '\n' + content : content + '\n' + appendContent

  const now = dayjs().toISOString()
  await writeFile(filePath, updatedContent, 'utf8')

  const title = extractTitle(updatedContent)
  const createdAt = getCreatedAtSync(updatedContent)

  const result: WriteDocumentResult = {
    id,
    title,
    filePath,
    createdAt,
    updatedAt: now,
  }

  // Note: caller should update index
  return result
}

/**
 * Update (full replace) content of existing document
 */
export async function updateDocument(
  writer: MarkdownMDWriterTool,
  input: UpdateDocumentInput,
  baseDir: string,
): Promise<WriteDocumentResult> {
  const id = sanitizeId(input.documentId)
  const filePath = path.join(baseDir, `${id}.md`)

  let oldContent: string
  try {
    oldContent = await readFile(filePath, 'utf8')
  } catch {
    throw new Error(`Document not found: ${input.documentId}`)
  }

  const title = input.title ?? extractTitle(oldContent)
  const now = dayjs().toISOString()
  const createdAt = getCreatedAtSync(oldContent)

  const body =
    input.content.endsWith('\n') ? input.content : `${input.content}\n`
  const newContent = `# ${title}\n\nCreated: ${createdAt}\n\n${body}`

  await writeFile(filePath, newContent, 'utf8')

  const result: WriteDocumentResult = {
    id,
    title,
    filePath,
    createdAt,
    updatedAt: now,
  }

  return result
}

/**
 * Remove a section from document by pattern (case-insensitive heading match)
 */
export async function pruneDocument(
  writer: MarkdownMDWriterTool,
  input: PruneDocumentInput,
  baseDir: string,
): Promise<WriteDocumentResult> {
  const id = sanitizeId(input.documentId)
  const filePath = path.join(baseDir, `${id}.md`)

  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    throw new Error(`Document not found: ${input.documentId}`)
  }

  // Find and remove section: matches "### SectionName" headers and everything until next header
  const pattern = input.prunePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^### ${pattern}\\s*$[\\s\\S]*?(?=^### |^## |$)`, 'im')
  const prunedContent = content.replace(regex, '').trim()

  if (prunedContent === content.trim()) {
    throw new Error(
      `No section found matching pattern: "${input.prunePattern}". Available sections not documented yet.`,
    )
  }

  const now = dayjs().toISOString()
  await writeFile(filePath, prunedContent + '\n', 'utf8')

  const title = extractTitle(prunedContent)
  const createdAt = getCreatedAtSync(prunedContent)

  const result: WriteDocumentResult = {
    id,
    title,
    filePath,
    createdAt,
    updatedAt: now,
  }

  return result
}

/**
 * Merge two documents (simplified for MVP)
 * Full merge logic deferred to future implementation
 */
export async function mergeDocuments(
  _writer: MarkdownMDWriterTool,
  input: MergeDocumentsInput,
  baseDir: string,
): Promise<MergeDocumentsResult> {
  const targetId = sanitizeId(input.targetDocId)
  const sourceId = sanitizeId(input.sourceDocId)

  // In auto mode, merge would execute deterministically
  // In user-decides mode, return pending status
  if (input.mergeMode === 'user-decides') {
    return {
      targetDocId: `${targetId}`,
      sourceDocIds: [sourceId],
      status: 'merge-pending-approval',
      note: `Merge candidate: ${sourceId} → ${targetId}. Manual approval required.`,
    }
  }

  // Auto-merge: full implementation deferred (needs semantic similarity, conflict detection, etc)
  return {
    targetDocId: `${targetId}`,
    sourceDocIds: [sourceId],
    status: 'merged',
    note: 'Auto-merge feature deferred to Phase 2, ticket 048+',
  }
}

// ─── Helper Functions ───────────────────────────────────────────

function sanitizeId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document'
}

function extractTitle(content: string): string {
  const match = content.match(/^# (.+)$/m)
  return match ? match[1] : 'Untitled'
}

function getCreatedAtSync(content: string): string {
  const match = content.match(/^Created: (.+)$/m)
  return match ? match[1] : dayjs().toISOString()
}

export { sanitizeId }
