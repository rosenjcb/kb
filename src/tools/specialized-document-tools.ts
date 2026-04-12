/**
 * Specialized Document Operation Tools
 * Following separation-of-concerns pattern from TOOL_CONVENTIONS.md:
 * One tool per responsibility (append, update, merge, prune, query)
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import dayjs from 'dayjs'
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
  const typeLine = getMetadataLine(oldContent, 'Type')
  const tagsLine = getMetadataLine(oldContent, 'Tags')

  const body =
    input.content.endsWith('\n') ? input.content : `${input.content}\n`
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
  const regex = new RegExp(`(^### ${pattern}\\s*\\n)[\\s\\S]*?(?=\\n### |\\n## |$)`, 'im')
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
  input: MergeDocumentsInput,
  baseDir: string,
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
    normalizeContentForSimilarity(sourceContent),
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
  sourceId: string,
): string {
  const cleanPrimary = primary.endsWith('\n') ? primary : `${primary}\n`
  const cleanSecondary = secondary.trim()
  return `${cleanPrimary}\n## Merged Notes (${sourceId})\n\n${cleanSecondary}\n`
}

export { sanitizeId }
