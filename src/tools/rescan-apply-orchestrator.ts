import path from 'node:path'
import { renderDiffBundle, renderTextDiff } from '../core/git-diff-preview'
import type { ToolExecutor } from '../core/tool-registry'
import type { ToolUseRequest } from '../core/types'
import { DefaultIntentRouter } from '../intents/router'
import type { ConsumerIntentEnvelope } from '../intents/types'
import { invalidateFactTool } from './invalidate-fact-tool'
import { SqliteDocumentWriter } from './sqlite-document-writer'
import { SqliteKbIndexer } from './sqlite-kb-index'

export type RescanClaimAction = 'noop' | 'append_existing' | 'submit' | 'invalidate_then_submit'

export interface RescanCandidateClaim {
  claimId: string
  text: string
  topic: string
  sourcePaths: string[]
  confidence: number
}

export interface RescanEvidenceResult {
  claimId: string
  supportDocs: string[]
  equivalentDocs: string[]
  contradictionDocs: string[]
  contradictionFacts: string[]
  evidenceScore: number
}

export interface RescanPlannedMutation {
  claimId: string
  action: RescanClaimAction
  targetDocId?: string
  invalidateFact?: string
  submitFact?: string
  rationale: string
  expectedPostcondition: string
}

export interface RescanPlanSummary {
  dryRun: boolean
  changedReadmes: string[]
  claims: RescanCandidateClaim[]
  evidence: RescanEvidenceResult[]
  mutations: RescanPlannedMutation[]
  apply: {
    appliedMutations: number
    noopMutations: number
    errors: string[]
  }
  safeguards?: {
    stageTimeoutMs: number
    maxClaims: number
    maxEvidenceDocs: number
    maxMutations: number
    triggered: string[]
  }
}

interface CandidateDocLike {
  title: string
  content: string
  tags?: string[]
  isOriginal?: boolean
}

export interface RunRescanApplyOrchestratorInput {
  base: string
  baseDir: string
  cwd: string
  dryRun: boolean
  sourceFiles: Record<string, string>
  candidateDocs: CandidateDocLike[]
  stageTimeoutMs?: number
  maxClaims?: number
  maxEvidenceDocs?: number
  maxMutations?: number
}

export interface RunRescanApplyOrchestratorResult {
  plan: RescanPlanSummary
  previewDiff: string
  writtenDocIds: string[]
}

export async function runRescanApplyOrchestrator(
  input: RunRescanApplyOrchestratorInput
): Promise<RunRescanApplyOrchestratorResult> {
  const stageTimeoutMs = clampPositiveInt(input.stageTimeoutMs, 30_000)
  const maxClaims = clampPositiveInt(input.maxClaims, 20)
  const maxEvidenceDocs = clampPositiveInt(input.maxEvidenceDocs, 300)
  const maxMutations = clampPositiveInt(input.maxMutations, 80)
  const triggered: string[] = []

  const claims = extractClaims(input.candidateDocs, input.sourceFiles, maxClaims)
  if (claims.length >= maxClaims) {
    triggered.push(`claims-capped:${maxClaims}`)
  }
  const evidenceResult = gatherEvidence(claims, input.baseDir, {
    maxEvidenceDocs,
    stageTimeoutMs,
  })
  if (evidenceResult.timedOut) {
    triggered.push(`evidence-timeout:${stageTimeoutMs}ms`)
  }
  if (evidenceResult.cappedDocs) {
    triggered.push(`evidence-doc-cap:${maxEvidenceDocs}`)
  }
  const evidence = evidenceResult.results
  const mutations = planMutations(claims, evidence).slice(0, maxMutations)
  if (mutations.length >= maxMutations) {
    triggered.push(`mutation-cap:${maxMutations}`)
  }
  const applyResult = await applyMutations({
    base: input.base,
    baseDir: input.baseDir,
    dryRun: input.dryRun,
    claims,
    stageTimeoutMs,
    mutations,
  })
  if (applyResult.timedOut) {
    triggered.push(`apply-timeout:${stageTimeoutMs}ms`)
  }

  const plan: RescanPlanSummary = {
    dryRun: input.dryRun,
    changedReadmes: Object.keys(input.sourceFiles),
    claims,
    evidence,
    mutations,
    apply: {
      appliedMutations: applyResult.appliedMutations,
      noopMutations: applyResult.noopMutations,
      errors: applyResult.errors,
    },
    safeguards: {
      stageTimeoutMs,
      maxClaims,
      maxEvidenceDocs,
      maxMutations,
      triggered,
    },
  }
  const previewDiff = await buildPlanDiff({
    base: input.base,
    baseDir: input.baseDir,
    claims,
    mutations,
    stageTimeoutMs,
  })
  return {
    plan,
    previewDiff,
    writtenDocIds: applyResult.writtenDocIds,
  }
}

function extractClaims(
  candidateDocs: CandidateDocLike[],
  sourceFiles: Record<string, string>,
  maxClaims: number
): RescanCandidateClaim[] {
  const sourcePaths = Object.keys(sourceFiles)
  const claimMap = new Map<string, RescanCandidateClaim>()
  for (const doc of candidateDocs) {
    if (doc.isOriginal) continue
    const topic = doc.tags?.[0] ?? slugify(doc.title).slice(0, 40)
    const snippets = extractClaimSnippets(doc.content)
    for (const snippet of snippets) {
      if (!isClaimCandidate(snippet)) continue
      const claimId = claimFingerprint(snippet)
      if (claimMap.has(claimId)) continue
      claimMap.set(claimId, {
        claimId,
        text: snippet,
        topic,
        sourcePaths,
        confidence: estimateConfidence(snippet),
      })
      if (claimMap.size >= maxClaims) break
    }
    if (claimMap.size >= maxClaims) break
  }
  return Array.from(claimMap.values())
}

function gatherEvidence(
  claims: RescanCandidateClaim[],
  baseDir: string,
  limits: { maxEvidenceDocs: number; stageTimeoutMs: number }
): { results: RescanEvidenceResult[]; timedOut: boolean; cappedDocs: boolean } {
  const startedAt = Date.now()
  let timedOut = false
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  try {
    const allRows = indexer.getAllDocumentsForLexical()
    const rows = allRows.slice(0, limits.maxEvidenceDocs)
    const cappedDocs = allRows.length > rows.length
    const results = claims.map(claim => {
      if (Date.now() - startedAt > limits.stageTimeoutMs) {
        timedOut = true
        return {
          claimId: claim.claimId,
          supportDocs: [],
          equivalentDocs: [],
          contradictionDocs: [],
          contradictionFacts: [],
          evidenceScore: 0,
        }
      }
      const equivalentDocs: string[] = []
      const contradictionDocs: string[] = []
      const contradictionFacts: string[] = []
      const supportDocs: string[] = []
      const claimNorm = normalizeText(claim.text)
      for (const row of rows) {
        if (Date.now() - startedAt > limits.stageTimeoutMs) {
          timedOut = true
          break
        }
        const contentNorm = normalizeText(row.content)
        const overlap = keywordOverlap(claimNorm, contentNorm)
        const equivalent =
          contentNorm.includes(claimNorm) ||
          (overlap >= 0.75 && !hasNegationConflict(claimNorm, contentNorm))
        if (equivalent) {
          equivalentDocs.push(row.id)
          supportDocs.push(row.id)
          continue
        }
        if (overlap >= 0.6) {
          supportDocs.push(row.id)
        }
        if (overlap >= 0.8 && hasNegationConflict(claimNorm, contentNorm)) {
          contradictionDocs.push(row.id)
          const candidateFact = pickContradictionFact(row.content, claimNorm)
          contradictionFacts.push(candidateFact.slice(0, 240))
        }
      }
      const evidenceScore = clamp(
        (equivalentDocs.length > 0 ? 0.75 : 0) +
          Math.min(supportDocs.length, 4) * 0.05 -
          Math.min(contradictionDocs.length, 2) * 0.1,
        0,
        1
      )
      return {
        claimId: claim.claimId,
        supportDocs: dedup(supportDocs),
        equivalentDocs: dedup(equivalentDocs),
        contradictionDocs: dedup(contradictionDocs),
        contradictionFacts: dedup(contradictionFacts),
        evidenceScore,
      }
    })
    return { results, timedOut, cappedDocs }
  } finally {
    indexer.close()
  }
}

function planMutations(
  claims: RescanCandidateClaim[],
  evidence: RescanEvidenceResult[]
): RescanPlannedMutation[] {
  const evidenceById = new Map(evidence.map(item => [item.claimId, item]))
  return claims.map(claim => {
    const e = evidenceById.get(claim.claimId)
    if (!e) {
      return {
        claimId: claim.claimId,
        action: 'noop',
        rationale: 'No evidence found and no safe insertion target identified; skipped conservatively.',
        expectedPostcondition: 'No KB mutation should be required without a clear target document.',
      }
    }
    const targetDocId = pickTargetDocumentId(e)
    if (e.equivalentDocs.length > 0 && e.contradictionDocs.length === 0) {
      if (claim.text.length > 180) {
        if (!targetDocId) {
          return {
            claimId: claim.claimId,
            action: 'noop',
            rationale: 'Equivalent evidence exists but no safe target doc was resolved for insertion.',
            expectedPostcondition: 'No KB mutation should be required.',
          }
        }
        return {
          claimId: claim.claimId,
          action: 'append_existing',
          targetDocId,
          submitFact: claim.text,
          rationale: 'Equivalent evidence exists, but claim carries additional detail to append.',
          expectedPostcondition: 'Target document contains appended detail for this fact family.',
        }
      }
      return {
        claimId: claim.claimId,
        action: 'noop',
        rationale: 'Equivalent fact already exists with no detected contradiction.',
        expectedPostcondition: 'No KB mutation should be required.',
      }
    }
    if (e.supportDocs.length >= 2 && e.evidenceScore >= 0.2 && e.contradictionDocs.length === 0) {
      return {
        claimId: claim.claimId,
        action: 'noop',
        rationale: 'Related supporting evidence already exists; skipping low-value duplicate mutation.',
        expectedPostcondition: 'No KB mutation should be required.',
      }
    }
    const contradictionFact = e.contradictionFacts[0]
    if (
      e.contradictionDocs.length > 0 &&
      claim.confidence >= 0.6 &&
      e.evidenceScore >= 0.45 &&
      isSafeInvalidationFact(contradictionFact)
    ) {
      if (!targetDocId) {
        return {
          claimId: claim.claimId,
          action: 'noop',
          rationale: 'Contradiction detected, but no safe target doc was resolved for replacement insertion.',
          expectedPostcondition: 'No KB mutation should be required without a clear target document.',
        }
      }
      return {
        claimId: claim.claimId,
        action: 'invalidate_then_submit',
        targetDocId,
        invalidateFact: contradictionFact,
        submitFact: claim.text,
        rationale: 'Contradicting evidence exists and new claim confidence/evidence pass threshold.',
        expectedPostcondition: 'Contradicting statement is removed/replaced and new claim is retrievable.',
      }
    }
    if (claim.confidence < 0.65) {
      return {
        claimId: claim.claimId,
        action: 'noop',
        rationale: 'Claim confidence is below submit threshold and does not justify a write.',
        expectedPostcondition: 'No KB mutation should be required.',
      }
    }
    if (!targetDocId) {
      return {
        claimId: claim.claimId,
        action: 'noop',
        rationale: 'No safe insertion target was resolved; skipped to avoid creating synthetic files.',
        expectedPostcondition: 'No KB mutation should be required.',
      }
    }
    return {
      claimId: claim.claimId,
      action: 'append_existing',
      targetDocId,
      submitFact: claim.text,
      rationale: 'No strong equivalent found; append claim into best supporting document.',
      expectedPostcondition: 'Target document contains inserted fact and retrieval should surface it.',
    }
  })
}

async function applyMutations(input: {
  base: string
  baseDir: string
  dryRun: boolean
  claims: RescanCandidateClaim[]
  stageTimeoutMs: number
  mutations: RescanPlannedMutation[]
}): Promise<{
  writtenDocIds: string[]
  appliedMutations: number
  noopMutations: number
  errors: string[]
  timedOut: boolean
}> {
  const startedAt = Date.now()
  let timedOut = false
  const claimById = new Map(input.claims.map(claim => [claim.claimId, claim]))
  const writer = new SqliteDocumentWriter({ baseDir: input.baseDir, base: input.base })
  const indexer = new SqliteKbIndexer({ dbPath: path.join(input.baseDir, '.kb-index.sqlite') })
  const intentExecutor = createRescanIntentExecutor(writer, indexer)
  const intentRouter = new DefaultIntentRouter(intentExecutor)
  const writtenDocIds: string[] = []
  const errors: string[] = []
  let appliedMutations = 0
  let noopMutations = 0

  try {
    for (const mutation of input.mutations) {
      if (Date.now() - startedAt > input.stageTimeoutMs) {
        timedOut = true
        errors.push(`apply stage timed out after ${input.stageTimeoutMs}ms`)
        break
      }
      const claim = claimById.get(mutation.claimId)
      if (!claim) continue
      if (mutation.action === 'noop') {
        noopMutations += 1
        continue
      }
      if (input.dryRun) continue
      try {
        if (mutation.action === 'invalidate_then_submit' && mutation.invalidateFact) {
          await invalidateFactTool(
            {
              oldFact: mutation.invalidateFact,
              replacementFact: '',
              preview: false,
              dryRun: false,
              includeSessionLogs: false,
            },
            input.baseDir
          )
        }
        if (mutation.submitFact) {
          const result = await submitViaIntentRouter({
            router: intentRouter,
            fact: mutation.submitFact,
            targetDocumentId: mutation.targetDocId,
          })
          const id = extractResultId(result)
          if (id) writtenDocIds.push(id)
        }
        appliedMutations += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${mutation.claimId}: ${message}`)
      }
    }
  } finally {
    indexer.close()
  }

  return { writtenDocIds, appliedMutations, noopMutations, errors, timedOut }
}

function claimFingerprint(value: string): string {
  const normalized = normalizeText(value)
  let hash = 0
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function keywordOverlap(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(token => token.length > 4))
  const right = new Set(b.split(' ').filter(token => token.length > 4))
  if (left.size === 0 || right.size === 0) return 0
  let overlap = 0
  for (const token of left) {
    if (right.has(token)) overlap += 1
  }
  return overlap / Math.max(left.size, 1)
}

function hasNegationConflict(claimNorm: string, contentNorm: string): boolean {
  const claimNeg = /\b(not|never|no)\b/.test(claimNorm)
  const contentNeg = /\b(not|never|no)\b/.test(contentNorm)
  return claimNeg !== contentNeg
}

function pickContradictionFact(content: string, claimNorm: string): string {
  const lines = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 20)
    .filter(line => !/^type:\s*\w+/i.test(line))
  if (lines.length === 0) return content.trim()
  let best = lines[0]
  let bestScore = -1
  for (const line of lines) {
    const normalized = normalizeText(line)
    const score = keywordOverlap(claimNorm, normalized)
    if (score > bestScore) {
      best = line
      bestScore = score
    }
  }
  return best
}

function isSafeInvalidationFact(value: string | undefined): value is string {
  if (!value) return false
  const trimmed = value.trim()
  if (trimmed.length < 60 || trimmed.length > 320) return false
  if (!/[a-z]/i.test(trimmed)) return false
  if (/^\W/.test(trimmed)) return false
  if (!/[.!?]$/.test(trimmed)) return false
  if (/[,;:]\s*$/.test(trimmed)) return false
  if (/\s{2,}/.test(trimmed)) return false
  return true
}

function estimateConfidence(text: string): number {
  const tokenCount = text.split(/\s+/).filter(Boolean).length
  if (tokenCount < 8) return 0.35
  if (tokenCount >= 20) return 0.85
  if (tokenCount >= 12) return 0.7
  return 0.55
}

function extractClaimSnippets(content: string): string[] {
  const lines = content
    .split('\n')
    .map(line => sanitizeMarkdownLine(line))
    .filter(Boolean)
    .filter(line => !isLikelyHeading(line))
    .slice(0, 120)
  const snippets: string[] = []
  for (const line of lines) {
    for (const sentence of splitIntoSentences(line)) {
      const normalized = sentence.trim()
      if (!normalized) continue
      snippets.push(normalized)
      if (snippets.length >= 80) return snippets
    }
  }
  return snippets
}

function sanitizeMarkdownLine(line: string): string {
  return line
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#>*+\-\d.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitIntoSentences(line: string): string[] {
  return line
    .split(/(?<=[.?!])\s+/)
    .map(part => part.trim())
    .filter(Boolean)
}

function isLikelyHeading(line: string): boolean {
  if (line.length < 4) return true
  if (!/[a-z]/i.test(line)) return true
  if (line.endsWith(':') && !line.includes(' ')) return true
  return false
}

function isClaimCandidate(value: string): boolean {
  if (value.length < 45 || value.length > 420) return false
  if (!/[a-z]/i.test(value)) return false
  if (!/\s/.test(value)) return false
  if (/[{}[\]|]/.test(value)) return false
  if (/\btype:\s*\w+/i.test(value)) return false
  if (/[,:]\s*[,:]/.test(value)) return false
  const lower = value.toLowerCase()
  if (lower.startsWith('rescan ')) return false
  if (lower.includes(' run `') || lower.includes(' use `')) return false
  if (/(^|\s)\*+\s*:/.test(lower)) return false
  const words = lower.split(/\s+/).filter(Boolean)
  const longWords = words.filter(word => /[a-z]/.test(word) && word.length > 2).length
  return words.length >= 8 && longWords >= 6
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function dedup<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value) return fallback
  return Math.max(1, Math.floor(value))
}

function pickTargetDocumentId(evidence: RescanEvidenceResult): string | undefined {
  return evidence.equivalentDocs[0] ?? evidence.supportDocs[0] ?? evidence.contradictionDocs[0]
}

function createRescanIntentExecutor(
  writer: SqliteDocumentWriter,
  indexer: SqliteKbIndexer
): ToolExecutor {
  return {
    register() {},
    getTools() {
      return []
    },
    async execute(toolUse: ToolUseRequest): Promise<unknown> {
      if (toolUse.name === 'append_to_document') {
        const documentId = String(toolUse.input.documentId ?? '').trim()
        const content = String(toolUse.input.content ?? '')
        return writer.appendToDocument?.({
          documentId,
          content: content.startsWith('\n') ? content : `\n${content}`,
          position: 'bottom',
        })
      }
      if (toolUse.name === 'write_document') {
        const type = asWriteDocType(toolUse.input.type)
        return writer.writeDocument({
          documentId: String(toolUse.input.documentId ?? '').trim(),
          title: String(toolUse.input.title ?? '').trim() || 'rescan facts',
          content: String(toolUse.input.content ?? ''),
          tags: Array.isArray(toolUse.input.tags)
            ? toolUse.input.tags.filter((tag): tag is string => typeof tag === 'string')
            : undefined,
          type,
          overwrite: toolUse.input.overwrite !== false,
          isOriginal: false,
        })
      }
      if (toolUse.name === 'read_documents') {
        const query = normalizeText(String(toolUse.input.query ?? ''))
        const rows = indexer.getAllDocumentsForLexical()
        const ranked = rows
          .map(row => ({ row, score: keywordOverlap(query, normalizeText(row.content)) }))
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(1, Number(toolUse.input.limit ?? 3)))
        return {
          retrieval: { method: 'hybrid' },
          results: ranked.map(item => ({ metadata: { id: item.row.id } })),
        }
      }
      if (toolUse.name === 'reconcile_contradictions') {
        return { changedDocumentIds: [], removedFacts: 0 }
      }
      throw new Error(`Unsupported rescan intent tool: ${toolUse.name}`)
    },
  }
}

function asWriteDocType(value: unknown):
  | 'architecture'
  | 'decision'
  | 'checklist'
  | 'runbook'
  | 'reference' {
  return value === 'architecture' ||
    value === 'decision' ||
    value === 'checklist' ||
    value === 'runbook' ||
    value === 'reference'
    ? value
    : 'reference'
}

async function submitViaIntentRouter(input: {
  router: DefaultIntentRouter
  fact: string
  targetDocumentId?: string
}): Promise<unknown> {
  const envelope: ConsumerIntentEnvelope = {
    intent: 'submit_fact',
    payload: {
      fact: input.fact,
      source: 'rescan',
      ...(input.targetDocumentId ? { targetDocumentId: input.targetDocumentId } : {}),
    },
  }
  const result = await input.router.execute(envelope)
  if (result.status === 'error') {
    throw new Error(result.explanation ?? 'submit_fact intent failed')
  }
  return result.data
}

function extractResultId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id === 'string') return record.id
  if (record.submission && typeof record.submission === 'object') {
    const nested = record.submission as Record<string, unknown>
    if (typeof nested.id === 'string') return nested.id
  }
  return undefined
}

async function buildPlanDiff(input: {
  base: string
  baseDir: string
  claims: RescanCandidateClaim[]
  mutations: RescanPlannedMutation[]
  stageTimeoutMs: number
}): Promise<string> {
  const startedAt = Date.now()
  const claimById = new Map(input.claims.map(claim => [claim.claimId, claim]))
  const indexer = new SqliteKbIndexer({ dbPath: path.join(input.baseDir, '.kb-index.sqlite') })
  try {
    const sections: string[] = []
    for (const mutation of input.mutations) {
      if (Date.now() - startedAt > input.stageTimeoutMs) break
      if (mutation.action === 'noop') continue
      const claim = claimById.get(mutation.claimId)
      if (!claim) continue

      if (mutation.action === 'append_existing' && mutation.targetDocId && mutation.submitFact) {
        const before = indexer.getDocumentContent(mutation.targetDocId) ?? ''
        const after = `${before}${before.endsWith('\n') ? '' : '\n'}- ${mutation.submitFact} (source: rescan)\n`
        sections.push(renderTextDiff(`docs/${mutation.targetDocId}.md`, before, after))
        continue
      }

      if (mutation.action === 'invalidate_then_submit' && mutation.invalidateFact) {
        const preview = await invalidateFactTool(
          {
            oldFact: mutation.invalidateFact,
            replacementFact: '',
            preview: true,
            dryRun: true,
            includeSessionLogs: false,
          },
          input.baseDir
        )
        for (const change of preview.changes.slice(0, 3)) {
          sections.push(renderTextDiff(`docs/${change.documentId}.md`, change.before, change.after))
        }
      }

      if (mutation.submitFact && mutation.targetDocId) {
        const before = indexer.getDocumentContent(mutation.targetDocId) ?? ''
        const after = `${before}${before.endsWith('\n') ? '' : '\n'}- ${mutation.submitFact} (source: rescan)\n`
        sections.push(renderTextDiff(`docs/${mutation.targetDocId}.md`, before, after))
      }
    }

    return renderDiffBundle(sections, '# No proposed content changes for this rescan plan.')
  } finally {
    indexer.close()
  }
}
