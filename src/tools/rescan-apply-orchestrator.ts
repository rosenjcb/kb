import path from 'node:path'
import { renderDiffBundle, renderNewFileDiff, renderTextDiff } from '../core/git-diff-preview'
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
        if (overlap >= 0.5 && hasNegationConflict(claimNorm, contentNorm)) {
          contradictionDocs.push(row.id)
          const firstLine = row.content.split('\n').find(line => line.trim().length > 0) ?? row.content
          contradictionFacts.push(firstLine.trim().slice(0, 240))
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
        action: 'submit',
        submitFact: claim.text,
        rationale: 'No evidence found for this claim; adding as new fact.',
        expectedPostcondition: 'A retrieval query should find this claim in at least one KB document.',
      }
    }
    if (e.equivalentDocs.length > 0 && e.contradictionDocs.length === 0) {
      if (claim.text.length > 180) {
        return {
          claimId: claim.claimId,
          action: 'append_existing',
          targetDocId: e.equivalentDocs[0],
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
    if (e.contradictionDocs.length > 0 && claim.confidence >= 0.6 && e.evidenceScore >= 0.45) {
      return {
        claimId: claim.claimId,
        action: 'invalidate_then_submit',
        invalidateFact: e.contradictionFacts[0] ?? claim.text,
        submitFact: claim.text,
        rationale: 'Contradicting evidence exists and new claim confidence/evidence pass threshold.',
        expectedPostcondition: 'Contradicting statement is removed/replaced and new claim is retrievable.',
      }
    }
    return {
      claimId: claim.claimId,
      action: 'submit',
      submitFact: claim.text,
      rationale: 'No strong equivalent and contradiction threshold not met.',
      expectedPostcondition: 'Submitted fact appears in retrieval results.',
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
  const writtenDocIds: string[] = []
  const errors: string[] = []
  let appliedMutations = 0
  let noopMutations = 0

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
      if (mutation.action === 'append_existing' && mutation.targetDocId && mutation.submitFact) {
        const result = await writer.appendToDocument?.({
          documentId: mutation.targetDocId,
          content: `\n- ${mutation.submitFact}`,
          position: 'bottom',
        })
        if (result?.id) writtenDocIds.push(result.id)
        appliedMutations += 1
        continue
      }
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
        const writeResult = await writer.writeDocument({
          title: buildSubmitTitle(claim),
          content: `Rescan claim:\n\n${mutation.submitFact}`,
          tags: ['rescan-claim', claim.topic, input.base],
          type: 'reference',
          overwrite: true,
          documentId: `rescan-${claim.claimId.slice(0, 16)}`,
          isOriginal: false,
        })
        writtenDocIds.push(writeResult.id)
      }
      appliedMutations += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${mutation.claimId}: ${message}`)
    }
  }

  return { writtenDocIds, appliedMutations, noopMutations, errors, timedOut }
}

function buildSubmitTitle(claim: RescanCandidateClaim): string {
  const topic = claim.topic.replace(/[-_]+/g, ' ')
  return `Rescan ${topic}: ${claim.text.slice(0, 52)}`
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
    .replace(/`[^`]+`/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[#>\-\d.\s]+/, '')
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
  const lower = value.toLowerCase()
  if (lower.startsWith('rescan ')) return false
  if (lower.includes(' run `') || lower.includes(' use `')) return false
  const words = lower.split(/\s+/).filter(Boolean)
  return words.length >= 8
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
        const after = `${before}${before.endsWith('\n') ? '' : '\n'}- ${mutation.submitFact}\n`
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

      if (mutation.submitFact) {
        const nextId = `rescan-${claim.claimId.slice(0, 16)}`
        const newBody = `# ${buildSubmitTitle(claim)}\n\nRescan claim:\n\n${mutation.submitFact}\n`
        sections.push(renderNewFileDiff(`docs/${nextId}.md`, newBody))
      }
    }

    return renderDiffBundle(sections, '# No proposed content changes for this rescan plan.')
  } finally {
    indexer.close()
  }
}
