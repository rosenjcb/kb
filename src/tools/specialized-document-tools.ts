/**
 * Specialized Document Operation Tools
 * Following separation-of-concerns pattern from TOOL_CONVENTIONS.md:
 * One tool per responsibility (append, update, merge, prune, query)
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import dayjs from 'dayjs'
import type {
  AppendToDocumentInput,
  MergeDocumentsInput,
  MergeDocumentsResult,
  PruneDocumentInput,
  ReconcileContradictionsInput,
  ReconcileContradictionsResult,
  ReconcileFactsInput,
  ReconcileFactsResult,
  UpdateDocumentInput,
  WriteDocumentResult,
} from './document-writer'
import { classifyDocumentLane } from './retrieval-lane-router'

/**
 * Append content to existing document (bottom by default)
 */
export async function appendToDocument(
  input: AppendToDocumentInput,
  baseDir: string
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
    input.position === 'top' ? `${appendContent}\n${content}` : `${content}\n${appendContent}`

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
  input: UpdateDocumentInput,
  baseDir: string
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
  const typeLine = getMetadataLine(oldContent, 'Type')
  const tagsLine = getMetadataLine(oldContent, 'Tags')

  const body = input.content.endsWith('\n') ? input.content : `${input.content}\n`
  const metadataLines = [
    `Created: ${createdAt}`,
    ...(typeLine ? [typeLine] : []),
    ...(tagsLine ? [tagsLine] : []),
  ]
  const newContent = `# ${title}\n\n${metadataLines.join('\n')}\n\n${body}`

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
  input: PruneDocumentInput,
  baseDir: string
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
  const regex = new RegExp(`(^### ${pattern}\\s*\\n)[\\s\\S]*?(?=\\n### |\\n## |$)`, 'im')
  const prunedContent = content.replace(regex, '').trim()

  if (prunedContent === content.trim()) {
    throw new Error(
      `No section found matching pattern: "${input.prunePattern}". Available sections not documented yet.`
    )
  }

  const now = dayjs().toISOString()
  await writeFile(filePath, `${prunedContent}\n`, 'utf8')

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
  input: MergeDocumentsInput,
  baseDir: string
): Promise<MergeDocumentsResult> {
  const targetId = sanitizeId(input.targetDocId)
  const sourceId = sanitizeId(input.sourceDocId)

  const targetPath = path.join(baseDir, `${targetId}.md`)
  const sourcePath = path.join(baseDir, `${sourceId}.md`)

  const [targetContent, sourceContent] = await Promise.all([
    readFile(targetPath, 'utf8').catch(() => {
      throw new Error(`Target document not found: ${input.targetDocId}`)
    }),
    readFile(sourcePath, 'utf8').catch(() => {
      throw new Error(`Source document not found: ${input.sourceDocId}`)
    }),
  ])

  const similarity = await computeSemanticSimilarity(
    normalizeContentForSimilarity(targetContent),
    normalizeContentForSimilarity(sourceContent)
  )

  const threshold = 0.6

  // In auto mode, merge would execute deterministically
  // In user-decides mode, return pending status
  if (input.mergeMode === 'user-decides') {
    return {
      targetDocId: `${targetId}`,
      sourceDocIds: [sourceId],
      status: 'merge-pending-approval',
      note: `Merge candidate: ${sourceId} -> ${targetId}. Similarity=${similarity.toFixed(2)}. Manual approval required.`,
    }
  }

  if (similarity < threshold) {
    return {
      targetDocId: `${targetId}`,
      sourceDocIds: [sourceId],
      status: 'merge-pending-approval',
      note: `Similarity ${similarity.toFixed(2)} below auto-merge threshold ${threshold.toFixed(2)}.`,
    }
  }

  // Deterministic resolution: newer-by-length heuristic (longer becomes primary body)
  const [primary, secondary] =
    targetContent.length >= sourceContent.length
      ? [targetContent, sourceContent]
      : [sourceContent, targetContent]

  const mergedBody = mergeContentDeterministically(primary, secondary, sourceId)
  await writeFile(targetPath, mergedBody, 'utf8')

  return {
    targetDocId: `${targetId}`,
    sourceDocIds: [sourceId],
    status: 'merged',
    note: `Auto-merged with semantic similarity ${similarity.toFixed(2)} using deterministic content merge.`,
  }
}

export async function reconcileFacts(
  input: ReconcileFactsInput,
  baseDir: string
): Promise<ReconcileFactsResult> {
  const replaceFrom = input.replaceFrom.trim()
  const replaceTo = input.replaceTo.trim()
  const dryRun = input.dryRun ?? false
  const includeSessionLogs = input.includeSessionLogs ?? false

  if (!replaceFrom || !replaceTo) {
    throw new Error('reconcile_facts requires non-empty replaceFrom and replaceTo')
  }

  if (replaceFrom === replaceTo) {
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
      discovery: {
        strategy: 'full-crawl',
        indexCandidateCount: 0,
      },
    }
  }

  const files = (await readdir(baseDir))
    .filter(file => file.endsWith('.md') && file !== '_table.md')
    .sort((a, b) => a.localeCompare(b))

  const indexCandidates = loadIndexCandidates(baseDir, replaceFrom)
  const indexCandidateSet = new Set(indexCandidates)

  const prioritizedFiles = [
    ...files.filter(file => indexCandidateSet.has(path.basename(file, '.md'))),
    ...files.filter(file => !indexCandidateSet.has(path.basename(file, '.md'))),
  ]

  const changedDocumentIds: string[] = []
  const skippedDocumentIds: string[] = []
  const proposedDiffs: ReconcileFactsResult['proposedDiffs'] = []
  let scannedDocs = 0
  let totalReplacements = 0

  for (const file of prioritizedFiles) {
    const filePath = path.join(baseDir, file)
    const content = await readFile(filePath, 'utf8')
    const metadata = parseMetadataForLane(filePath, content)
    if (!metadata) {
      continue
    }

    const lane = classifyDocumentLane(
      metadata.id,
      metadata.title,
      metadata.type,
      metadata.tags,
      metadata.filePath
    )

    if (!includeSessionLogs && lane === 'session-log') {
      skippedDocumentIds.push(metadata.id)
      continue
    }

    scannedDocs += 1
    const replacement = replaceTermInContent(content, replaceFrom, replaceTo)
    if (replacement.count === 0) {
      continue
    }

    totalReplacements += replacement.count
    changedDocumentIds.push(metadata.id)
    proposedDiffs.push({
      documentId: metadata.id,
      filePath,
      replacements: replacement.count,
      diff: buildUnifiedReplaceDiff(filePath, content, replaceFrom, replaceTo),
    })

    if (!dryRun) {
      await writeFile(filePath, replacement.content, 'utf8')
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
    discovery: {
      strategy: indexCandidates.length > 0 ? 'index-assisted+full-crawl' : 'full-crawl',
      indexCandidateCount: indexCandidates.length,
    },
  }
}

export async function reconcileContradictions(
  input: ReconcileContradictionsInput,
  baseDir: string
): Promise<ReconcileContradictionsResult> {
  const newFact = input.newFact.trim()
  const domain = sanitizeId(input.domain ?? 'general') || 'general'
  const includeSessionLogs = input.includeSessionLogs ?? false
  const dryRun = input.dryRun ?? false

  if (!newFact) {
    throw new Error('reconcile_contradictions requires non-empty newFact')
  }

  const parsed = parseFactClaim(newFact)
  if (!parsed) {
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

  const files = (await readdir(baseDir))
    .filter(file => file.endsWith('.md') && file !== '_table.md')
    .sort((a, b) => a.localeCompare(b))

  let scannedDocs = 0
  let removedFacts = 0
  const changedDocumentIds: string[] = []
  const proposedDiffs: ReconcileContradictionsResult['proposedDiffs'] = []

  for (const file of files) {
    const filePath = path.join(baseDir, file)
    const content = await readFile(filePath, 'utf8')
    const metadata = parseMetadataForLane(filePath, content)
    if (!metadata) continue

    const lane = classifyDocumentLane(
      metadata.id,
      metadata.title,
      metadata.type,
      metadata.tags,
      metadata.filePath
    )

    if (!includeSessionLogs && lane === 'session-log') continue
    if (!isDomainRelevant(metadata, domain)) continue

    scannedDocs += 1
    const removal = removeContradictoryFactLines(content, parsed)
    if (removal.removedCount === 0) continue

    removedFacts += removal.removedCount
    changedDocumentIds.push(metadata.id)
    proposedDiffs.push({
      documentId: metadata.id,
      filePath,
      replacements: removal.removedCount,
      diff: buildUnifiedRemoveDiff(filePath, removal.removedLines),
    })

    if (!dryRun) {
      await writeFile(filePath, removal.content, 'utf8')
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

// ─── Helper Functions ───────────────────────────────────────────

function sanitizeId(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'document'
  )
}

function parseMetadataForLane(
  filePath: string,
  content: string
): {
  id: string
  title: string
  type: string | null
  tags: string[]
  filePath: string
} | null {
  const lines = content.split('\n')
  if (!lines[0].startsWith('# ')) return null

  const id = path.basename(filePath, '.md')
  const title = lines[0].slice(2).trim() || id

  let type: string | null = null
  let tags: string[] = []
  for (let i = 1; i < Math.min(lines.length, 16); i += 1) {
    const line = lines[i].trim()
    if (line.startsWith('Type:')) {
      type = line.slice('Type:'.length).trim() || null
    }
    if (line.startsWith('Tags:')) {
      tags = line
        .slice('Tags:'.length)
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
    }
  }

  return { id, title, type, tags, filePath }
}

function replaceTermInContent(
  content: string,
  replaceFrom: string,
  replaceTo: string
): {
  content: string
  count: number
} {
  const regex = buildReplaceRegex(replaceFrom)

  const matches = content.match(regex)
  if (!matches || matches.length === 0) {
    return { content, count: 0 }
  }

  return {
    content: content.replace(regex, replaceTo),
    count: matches.length,
  }
}

function buildReplaceRegex(replaceFrom: string): RegExp {
  const escaped = replaceFrom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tokenLike = /^[a-z0-9_-]+$/i.test(replaceFrom)
  const pattern = tokenLike ? `\\b${escaped}\\b` : escaped
  return new RegExp(pattern, 'g')
}

function buildUnifiedReplaceDiff(
  filePath: string,
  content: string,
  replaceFrom: string,
  replaceTo: string
): string {
  const regex = buildReplaceRegex(replaceFrom)
  const lines = content.split('\n')
  const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/')
  const diffLines: string[] = [`--- a/${relativePath}`, `+++ b/${relativePath}`]

  let emitted = 0
  for (let i = 0; i < lines.length; i += 1) {
    const before = lines[i]
    if (!regex.test(before)) {
      regex.lastIndex = 0
      continue
    }
    regex.lastIndex = 0

    const after = before.replace(regex, replaceTo)
    if (before === after) {
      continue
    }

    diffLines.push(`@@ -${i + 1},1 +${i + 1},1 @@`)
    diffLines.push(`-${before}`)
    diffLines.push(`+${after}`)
    emitted += 1

    if (emitted >= 12) {
      diffLines.push('@@ ... diff truncated after 12 changed lines ... @@')
      break
    }
  }

  return diffLines.join('\n')
}

function buildUnifiedRemoveDiff(
  filePath: string,
  removedLines: Array<{ lineNumber: number; line: string }>
): string {
  const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/')
  const diffLines: string[] = [`--- a/${relativePath}`, `+++ b/${relativePath}`]

  for (const entry of removedLines.slice(0, 12)) {
    diffLines.push(`@@ -${entry.lineNumber},1 +${entry.lineNumber},0 @@`)
    diffLines.push(`-${entry.line}`)
  }

  if (removedLines.length > 12) {
    diffLines.push('@@ ... diff truncated after 12 removed lines ... @@')
  }

  return diffLines.join('\n')
}

function parseFactClaim(fact: string): { subject: string; predicate: string } | null {
  const cleaned = fact
    .replace(/^[-*]\s+/, '')
    .replace(/\(source:[^)]+\)/gi, '')
    .trim()

  const match = cleaned.match(
    /^(.*?)\s+(is|are|uses|use|requires|must|should|can|cannot|does not|do not)\s+(.+)$/i
  )
  if (!match) return null

  const subject = normalizeClaimToken(match[1])
  const predicate = normalizeClaimToken(match[3])
  if (!subject || !predicate) return null

  return { subject, predicate }
}

function normalizeClaimToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isDomainRelevant(metadata: { id: string; tags: string[] }, domain: string): boolean {
  if (domain === 'general') return true
  if (metadata.id.startsWith(`${domain}-`)) return true
  return metadata.tags.map(tag => sanitizeId(tag)).includes(domain)
}

function removeContradictoryFactLines(
  content: string,
  claim: { subject: string; predicate: string }
): {
  content: string
  removedCount: number
  removedLines: Array<{ lineNumber: number; line: string }>
} {
  const lines = content.split('\n')
  const kept: string[] = []
  const removedLines: Array<{ lineNumber: number; line: string }> = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/)
    if (!bulletMatch) {
      kept.push(line)
      continue
    }

    const parsedLine = parseFactClaim(bulletMatch[1])
    if (!parsedLine) {
      kept.push(line)
      continue
    }

    const sameSubject = parsedLine.subject === claim.subject
    const samePredicate = parsedLine.predicate === claim.predicate
    if (sameSubject && !samePredicate) {
      removedLines.push({ lineNumber: i + 1, line })
      continue
    }

    kept.push(line)
  }

  return {
    content: kept.join('\n'),
    removedCount: removedLines.length,
    removedLines,
  }
}

function loadIndexCandidates(baseDir: string, replaceFrom: string): string[] {
  const sqlitePath = path.join(baseDir, '.kb-index.sqlite')

  try {
    const db = new Database(sqlitePath, { readonly: true })
    try {
      const tokens = replaceFrom
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(token => token.length > 1)

      if (tokens.length === 0) return []

      const ftsQuery = tokens.join(' OR ')
      const rows = db
        .prepare(`
          SELECT DISTINCT doc_id
          FROM chunks_fts
          WHERE chunks_fts MATCH ?
          LIMIT 500
        `)
        .all(ftsQuery) as Array<{ doc_id: string }>

      return rows.map(row => row.doc_id)
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

function extractTitle(content: string): string {
  const match = content.match(/^# (.+)$/m)
  return match ? match[1] : 'Untitled'
}

function getCreatedAtSync(content: string): string {
  const match = content.match(/^Created: (.+)$/m)
  return match ? match[1] : dayjs().toISOString()
}

function getMetadataLine(content: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}: .+$`, 'm')
  const match = content.match(regex)
  return match ? match[0] : undefined
}

function normalizeContentForSimilarity(content: string): string {
  return content
    .replace(/^# .+$/gm, '')
    .replace(/^Created: .+$/gm, '')
    .replace(/^Tags: .+$/gm, '')
    .replace(/^Type: .+$/gm, '')
    .toLowerCase()
    .trim()
}

async function computeSemanticSimilarity(a: string, b: string): Promise<number> {
  const viaLLM = await tryLLMSimilarity(a, b)
  if (viaLLM !== null) return viaLLM
  return tokenJaccardSimilarity(a, b)
}

async function tryLLMSimilarity(a: string, b: string): Promise<number | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 20,
        messages: [
          {
            role: 'system',
            content:
              'Return only a decimal between 0 and 1 representing semantic similarity between two texts.',
          },
          {
            role: 'user',
            content: `TEXT_A:\n${a}\n\nTEXT_B:\n${b}`,
          },
        ],
      }),
    })

    if (!response.ok) return null
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw = payload.choices?.[0]?.message?.content?.trim() ?? ''
    const parsed = Number.parseFloat(raw)
    if (Number.isNaN(parsed)) return null
    return Math.max(0, Math.min(1, parsed))
  } catch {
    return null
  }
}

function tokenJaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(/\W+/).filter(Boolean))
  const setB = new Set(b.split(/\W+/).filter(Boolean))
  if (setA.size === 0 && setB.size === 0) return 1

  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection += 1
  }

  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

function mergeContentDeterministically(
  primary: string,
  secondary: string,
  sourceId: string
): string {
  const cleanPrimary = primary.endsWith('\n') ? primary : `${primary}\n`
  const cleanSecondary = secondary.trim()
  return `${cleanPrimary}\n## Merged Notes (${sourceId})\n\n${cleanSecondary}\n`
}

export { sanitizeId }
