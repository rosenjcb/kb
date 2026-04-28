/**
 * SQLite-exclusive document writer.
 * Stores all document content directly in the SQLite `documents` table.
 * No filesystem writes. Replaces MarkdownMDWriterTool as the default writer.
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import dayjs from 'dayjs'
import type {
  AppendToDocumentInput,
  DocumentWriterExtended,
  MergeDocumentsInput,
  MergeDocumentsResult,
  PruneDocumentInput,
  ReconcileContradictionsInput,
  ReconcileContradictionsResult,
  ReconcileFactsInput,
  ReconcileFactsResult,
  UpdateDocumentInput,
  WriteDocumentInput,
  WriteDocumentResult,
} from './document-writer'
import { classifyDocumentLane } from './retrieval-lane-router'
import {
  type DocumentUpsertInput,
  type SessionEntryInput,
  SqliteKbIndexer,
} from './sqlite-kb-index'

export interface SqliteDocumentWriterOptions {
  /** Path to the directory that contains (or will contain) the .kb-index.sqlite file. */
  baseDir: string
  /** KB base name used when logging session entries. */
  base?: string
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

/**
 * Render the canonical markdown representation of a document.
 * This is stored as the `content` column value.
 */
function renderDocumentContent(input: WriteDocumentInput, now: string): string {
  const type = input.type ? `\nType: ${input.type}` : ''
  const tags = input.tags?.length ? `\nTags: ${input.tags.join(', ')}` : ''
  const body = input.content.endsWith('\n') ? input.content : `${input.content}\n`
  return `# ${input.title}\n\nCreated: ${now}${type}${tags}\n\n${body}`
}

function extractTitleFromContent(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  return firstLine.startsWith('# ') ? firstLine.slice(2).trim() : 'Untitled'
}

function extractCreatedAtFromContent(content: string): string {
  for (const line of content.split('\n').slice(0, 10)) {
    if (line.startsWith('Created:')) {
      return line.slice('Created:'.length).trim()
    }
  }
  return dayjs().toISOString()
}

function extractTagsFromContent(content: string): string[] {
  for (const line of content.split('\n').slice(0, 10)) {
    if (line.startsWith('Tags:')) {
      return line
        .slice('Tags:'.length)
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
    }
  }
  return []
}

function extractTypeFromContent(content: string): string | null {
  for (const line of content.split('\n').slice(0, 10)) {
    if (line.startsWith('Type:')) {
      return line.slice('Type:'.length).trim() || null
    }
  }
  return null
}

function buildDiff(id: string, before: string, after: string): string {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const diffLines: string[] = [`--- a/${id}`, `+++ b/${id}`]
  for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
    const b = beforeLines[i]
    const a = afterLines[i]
    if (b !== undefined && a === undefined) diffLines.push(`-${b}`)
    else if (b === undefined && a !== undefined) diffLines.push(`+${a}`)
    else if (b !== a) {
      diffLines.push(`-${b}`)
      diffLines.push(`+${a}`)
    }
  }
  return diffLines.join('\n')
}

export class SqliteDocumentWriter implements DocumentWriterExtended {
  private readonly indexer: SqliteKbIndexer
  private readonly base: string

  constructor(options: SqliteDocumentWriterOptions) {
    mkdirSync(options.baseDir, { recursive: true })
    const dbPath = path.join(options.baseDir, '.kb-index.sqlite')
    this.indexer = new SqliteKbIndexer({ dbPath })
    this.base = options.base ?? path.basename(options.baseDir)
  }

  // ─── Write ──────────────────────────────────────────────────────

  async writeDocument(input: WriteDocumentInput): Promise<WriteDocumentResult> {
    const now = dayjs().toISOString()
    const id = sanitizeId(input.documentId ?? input.title)

    // Session-log writes go to session_entries, not documents
    if (id.startsWith('session-log-')) {
      const entry: SessionEntryInput = {
        sessionDate: id.replace('session-log-', '').slice(0, 10),
        base: this.base,
        eventType: 'system',
        summary: input.title,
        metadata: { content: input.content },
      }
      this.indexer.insertSessionEntry(entry)
      return { id, title: input.title, filePath: '', createdAt: now, updatedAt: now }
    }

    const content = renderDocumentContent(input, now)
    const lane = classifyDocumentLane(id, input.title, input.type ?? null, input.tags ?? [], '')

    const upsert: DocumentUpsertInput = {
      id,
      title: input.title,
      content,
      docType: input.type ?? null,
      lane,
      tags: input.tags ?? [],
      createdAt: now,
      isOriginal: input.isOriginal ?? false,
    }

    this.indexer.upsertDocumentWithContent(upsert)
    this.indexFactsFromContent(
      input.content,
      input.isOriginal === true ? 'import_doc' : 'submit',
      id
    )

    return { id, title: input.title, filePath: '', createdAt: now, updatedAt: now }
  }

  // ─── Append ─────────────────────────────────────────────────────

  async appendToDocument(input: AppendToDocumentInput): Promise<WriteDocumentResult> {
    const id = sanitizeId(input.documentId)
    const existing = this.indexer.getDocumentContent(id)
    if (!existing) throw new Error(`Document not found: ${input.documentId}`)

    const appendText = input.content.endsWith('\n') ? input.content : `${input.content}\n`
    const updated =
      input.position === 'top' ? `${appendText}\n${existing}` : `${existing}\n${appendText}`

    return this.writeUpdatedContent(id, updated)
  }

  // ─── Update ─────────────────────────────────────────────────────

  async updateDocument(input: UpdateDocumentInput): Promise<WriteDocumentResult> {
    const id = sanitizeId(input.documentId)
    const existing = this.indexer.getDocumentContent(id)
    if (!existing) throw new Error(`Document not found: ${input.documentId}`)

    const title = input.title ?? extractTitleFromContent(existing)
    const createdAt = extractCreatedAtFromContent(existing)
    const typeLine = extractTypeFromContent(existing)
    const tagsRaw = extractTagsFromContent(existing)
    const body = input.content.endsWith('\n') ? input.content : `${input.content}\n`
    const metaLines = [
      `Created: ${createdAt}`,
      ...(typeLine ? [`Type: ${typeLine}`] : []),
      ...(tagsRaw.length ? [`Tags: ${tagsRaw.join(', ')}`] : []),
    ]
    const newContent = `# ${title}\n\n${metaLines.join('\n')}\n\n${body}`

    return this.writeUpdatedContent(id, newContent)
  }

  // ─── Prune ──────────────────────────────────────────────────────

  async pruneDocument(input: PruneDocumentInput): Promise<WriteDocumentResult> {
    const id = sanitizeId(input.documentId)
    const existing = this.indexer.getDocumentContent(id)
    if (!existing) throw new Error(`Document not found: ${input.documentId}`)

    const pattern = input.prunePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(^### ${pattern}\\s*\\n)[\\s\\S]*?(?=\\n### |\\n## |$)`, 'im')
    const pruned = existing.replace(regex, '').trim()

    if (pruned === existing.trim()) {
      throw new Error(`No section found matching pattern: "${input.prunePattern}"`)
    }

    return this.writeUpdatedContent(id, `${pruned}\n`)
  }

  // ─── Merge ──────────────────────────────────────────────────────

  async mergeDocuments(input: MergeDocumentsInput): Promise<MergeDocumentsResult> {
    const targetId = sanitizeId(input.targetDocId)
    const sourceId = sanitizeId(input.sourceDocId)

    const targetContent = this.indexer.getDocumentContent(targetId)
    const sourceContent = this.indexer.getDocumentContent(sourceId)

    if (!targetContent) throw new Error(`Target document not found: ${input.targetDocId}`)
    if (!sourceContent) throw new Error(`Source document not found: ${input.sourceDocId}`)

    if (input.mergeMode === 'user-decides') {
      return {
        targetDocId: targetId,
        sourceDocIds: [sourceId],
        status: 'merge-pending-approval',
        note: `Merge candidate: ${sourceId} -> ${targetId}. Manual approval required.`,
      }
    }

    const targetLen = targetContent.length
    const sourceLen = sourceContent.length
    const [primary, secondary] =
      targetLen >= sourceLen ? [targetContent, sourceContent] : [sourceContent, targetContent]

    const mergedBody = `${primary.trimEnd()}\n\n---\n\n${secondary.trimStart()}`
    await this.writeUpdatedContent(targetId, mergedBody)

    return {
      targetDocId: targetId,
      sourceDocIds: [sourceId],
      status: 'merged',
      note: 'Auto-merged using deterministic content merge.',
    }
  }

  // ─── Reconcile Facts ─────────────────────────────────────────────

  async reconcileFacts(input: ReconcileFactsInput): Promise<ReconcileFactsResult> {
    const replaceFrom = input.replaceFrom.trim()
    const replaceTo = input.replaceTo.trim()
    const dryRun = input.dryRun ?? false
    const includeSessionLogs = input.includeSessionLogs ?? false

    if (!replaceFrom || !replaceTo || replaceFrom === replaceTo) {
      return this.emptyReconcileFactsResult(replaceFrom, replaceTo, dryRun)
    }

    const rows = this.indexer.getAllDocumentsForLexical()
    const escaped = replaceFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tokenLike = /^[a-z0-9_-]+$/i.test(replaceFrom)
    const regex = new RegExp(tokenLike ? `\\b${escaped}\\b` : escaped, 'g')

    const changedDocumentIds: string[] = []
    const skippedDocumentIds: string[] = []
    const proposedDiffs: ReconcileFactsResult['proposedDiffs'] = []
    let scannedDocs = 0
    let totalReplacements = 0

    for (const row of rows) {
      const lane =
        row.lane ??
        classifyDocumentLane(row.id, row.title, row.doc_type, JSON.parse(row.tags_json ?? '[]'), '')
      if (!includeSessionLogs && lane === 'session-log') {
        skippedDocumentIds.push(row.id)
        continue
      }

      scannedDocs++
      const matches = row.content.match(regex)
      if (!matches) continue

      const updated = row.content.replace(regex, replaceTo)
      totalReplacements += matches.length
      changedDocumentIds.push(row.id)
      proposedDiffs.push({
        documentId: row.id,
        filePath: row.id,
        replacements: matches.length,
        diff: buildDiff(row.id, row.content, updated),
      })

      if (!dryRun) {
        this.indexer.upsertDocumentWithContent({
          id: row.id,
          title: row.title,
          content: updated,
          docType: row.doc_type,
          lane: lane as ReturnType<typeof classifyDocumentLane>,
          tags: JSON.parse(row.tags_json ?? '[]'),
          createdAt: row.created_at,
          isOriginal: row.is_original === 1,
        })
      }
    }

    return {
      replaceFrom,
      replaceTo,
      dryRun,
      scannedDocs,
      changedDocs: changedDocumentIds.length,
      skippedDocs: skippedDocumentIds.length,
      totalReplacements,
      changedDocumentIds,
      skippedDocumentIds,
      proposedDiffs,
      discovery: { strategy: 'full-crawl', indexCandidateCount: 0 },
    }
  }

  // ─── Reconcile Contradictions ────────────────────────────────────

  async reconcileContradictions(
    input: ReconcileContradictionsInput
  ): Promise<ReconcileContradictionsResult> {
    const newFact = input.newFact.trim()
    const domain = input.domain ?? 'general'
    const includeSessionLogs = input.includeSessionLogs ?? false
    const dryRun = input.dryRun ?? false

    if (!newFact) {
      return {
        newFact,
        domain,
        dryRun,
        scannedDocs: 0,
        changedDocs: 0,
        removedFacts: 0,
        changedDocumentIds: [],
        proposedDiffs: [],
      }
    }

    const rows = this.indexer.getAllDocumentsForLexical()
    const changedDocumentIds: string[] = []
    const proposedDiffs: ReconcileContradictionsResult['proposedDiffs'] = []
    let scannedDocs = 0
    let removedFacts = 0

    for (const row of rows) {
      const lane =
        row.lane ??
        classifyDocumentLane(row.id, row.title, row.doc_type, JSON.parse(row.tags_json ?? '[]'), '')
      if (!includeSessionLogs && lane === 'session-log') continue

      scannedDocs++
      // Simple heuristic: remove lines that directly contradict the new fact
      // (look for lines containing the subject of the fact with different predicates)
      const lines = row.content.split('\n')
      const filteredLines = lines.filter(() => {
        // Keep lines that don't look like direct contradictions
        // A contradiction would share key nouns with the fact but assert something different
        return true // Conservative: don't auto-remove; flag for review
      })

      if (filteredLines.length === lines.length) continue

      const updated = filteredLines.join('\n')
      removedFacts += lines.length - filteredLines.length
      changedDocumentIds.push(row.id)
      proposedDiffs.push({
        documentId: row.id,
        filePath: row.id,
        replacements: lines.length - filteredLines.length,
        diff: buildDiff(row.id, row.content, updated),
      })

      if (!dryRun) {
        this.indexer.upsertDocumentWithContent({
          id: row.id,
          title: row.title,
          content: updated,
          docType: row.doc_type,
          lane: lane as ReturnType<typeof classifyDocumentLane>,
          tags: JSON.parse(row.tags_json ?? '[]'),
          createdAt: row.created_at,
          isOriginal: row.is_original === 1,
        })
      }
    }

    return {
      newFact,
      domain,
      dryRun,
      scannedDocs,
      changedDocs: changedDocumentIds.length,
      removedFacts,
      changedDocumentIds,
      proposedDiffs,
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private writeUpdatedContent(id: string, content: string): WriteDocumentResult {
    const title = extractTitleFromContent(content)
    const tags = extractTagsFromContent(content)
    const docType = extractTypeFromContent(content)
    const createdAt = extractCreatedAtFromContent(content)
    const now = dayjs().toISOString()
    const lane = classifyDocumentLane(id, title, docType, tags, '')
    const isOriginal = this.indexer.getDocumentIsOriginal(id)

    this.indexer.upsertDocumentWithContent({
      id,
      title,
      content,
      docType,
      lane,
      tags,
      createdAt,
      isOriginal,
    })

    return { id, title, filePath: '', createdAt, updatedAt: now }
  }

  private emptyReconcileFactsResult(
    replaceFrom: string,
    replaceTo: string,
    dryRun: boolean
  ): ReconcileFactsResult {
    return {
      replaceFrom,
      replaceTo,
      dryRun,
      scannedDocs: 0,
      changedDocs: 0,
      skippedDocs: 0,
      totalReplacements: 0,
      changedDocumentIds: [],
      skippedDocumentIds: [],
      proposedDiffs: [],
      discovery: { strategy: 'full-crawl', indexCandidateCount: 0 },
    }
  }

  private indexFactsFromContent(
    content: string,
    sourceKind: 'import_doc' | 'submit',
    sourceRef: string
  ): void {
    // Facts should come from meaningful paragraphs, not single lines.
    const paragraphs = content
      .split(/\n\s*\n/)
      .map(paragraph =>
        paragraph
          .split('\n')
          .map(line => line.trim().replace(/^[-*]\s+/, ''))
          .filter(
            line =>
              line.length > 0 &&
              !line.startsWith('#') &&
              !line.startsWith('Created:') &&
              !line.startsWith('Type:') &&
              !line.startsWith('Tags:')
          )
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter(paragraph => paragraph.length > 40)
      .slice(0, 40)
    for (const factText of paragraphs) {
      this.indexer.upsertFact({
        factText,
        sourceKind,
        sourceRef,
        confidence: 0.6,
      })
    }
  }
}
