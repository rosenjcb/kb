import { type EvidenceLabel, isEvidenceAtLeast } from '../core/evidence-label'
import path from 'node:path'
import { placeholderTripletFromFactText } from '../core/fact-triplet-placeholder'
import { renderDiffBundle, renderTextDiff } from '../core/git-diff-preview'
import { invalidateFactTool } from './invalidate-fact-tool'
import { SqliteKbIndexer } from './sqlite-kb-index'

export type RescanClaimAction = 'noop' | 'append_existing' | 'write' | 'replace'

export interface RescanCandidateClaim {
  claimId: string
  text: string
  topic: string
  sourcePaths: string[]
  /** How substantial the claim text is. Categorical — see `core/evidence-label`. */
  substance: EvidenceLabel
}

export interface RescanEvidenceResult {
  claimId: string
  supportDocs: string[]
  equivalentDocs: string[]
  contradictionDocs: string[]
  contradictionFacts: string[]
  evidence: EvidenceLabel
}

export interface RescanPlannedMutation {
  claimId: string
  action: RescanClaimAction
  targetDocId?: string
  oldFact?: string
  newFact?: string
  rationale: string
  expectedPostcondition: string
}

export interface RescanPlanSummary {
  preview: boolean
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
  apply: boolean
  sourceFiles: Record<string, string>
  candidateDocs: CandidateDocLike[]
  stageTimeoutMs?: number
  maxClaims?: number
  maxEvidenceDocs?: number
  maxMutations?: number
  onProgress?: (progress: RescanApplyOrchestratorProgress) => void
}

export interface RunRescanApplyOrchestratorResult {
  plan: RescanPlanSummary
  previewDiff: string
  writtenDocIds: string[]
}

export interface RescanApplyOrchestratorProgress {
  stage: 'extract-claims' | 'gather-evidence' | 'apply-mutations' | 'preview-diff'
  itemsConsidered: number
  itemsCompleted: number
  itemsRemaining: number
  currentItem?: string
  claimsExtracted?: number
  evidenceDocsScanned?: number
  appliedMutations?: number
  noopMutations?: number
}

export async function runRescanApplyOrchestrator(
  input: RunRescanApplyOrchestratorInput
): Promise<RunRescanApplyOrchestratorResult> {
  const stageTimeoutMs = clampPositiveInt(input.stageTimeoutMs, 30_000)
  const maxClaims = clampPositiveInt(input.maxClaims, 20)
  const maxEvidenceDocs = clampPositiveInt(input.maxEvidenceDocs, 300)
  const maxMutations = clampPositiveInt(input.maxMutations, 80)
  const triggered: string[] = []

  const claims = extractClaims(input.candidateDocs, input.sourceFiles, maxClaims, input.onProgress)
  if (claims.length >= maxClaims) {
    triggered.push(`claims-capped:${maxClaims}`)
  }
  const evidenceResult = gatherEvidence(claims, input.baseDir, {
    maxEvidenceDocs,
    stageTimeoutMs,
  }, input.onProgress)
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
    apply: input.apply,
    claims,
    stageTimeoutMs,
    mutations,
    onProgress: input.onProgress,
  })
  if (applyResult.timedOut) {
    triggered.push(`apply-timeout:${stageTimeoutMs}ms`)
  }

  const plan: RescanPlanSummary = {
    preview: !input.apply,
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
    onProgress: input.onProgress,
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
  maxClaims: number,
  onProgress?: (progress: RescanApplyOrchestratorProgress) => void
): RescanCandidateClaim[] {
  const sourcePaths = Object.keys(sourceFiles)
  const claimMap = new Map<string, RescanCandidateClaim>()
  for (const [index, doc] of candidateDocs.entries()) {
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
        substance: assessClaimSubstance(snippet),
      })
      if (claimMap.size >= maxClaims) break
    }
    onProgress?.({
      stage: 'extract-claims',
      itemsConsidered: candidateDocs.length,
      itemsCompleted: index + 1,
      itemsRemaining: Math.max(candidateDocs.length - (index + 1), 0),
      currentItem: doc.title,
      claimsExtracted: claimMap.size,
    })
    if (claimMap.size >= maxClaims) break
  }
  return Array.from(claimMap.values())
}

function gatherEvidence(
  claims: RescanCandidateClaim[],
  baseDir: string,
  limits: { maxEvidenceDocs: number; stageTimeoutMs: number },
  onProgress?: (progress: RescanApplyOrchestratorProgress) => void
): { results: RescanEvidenceResult[]; timedOut: boolean; cappedDocs: boolean } {
  const startedAt = Date.now()
  let timedOut = false
  const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
  try {
    const allRows = indexer.getAllDocumentsForLexical()
    const rows = allRows.slice(0, limits.maxEvidenceDocs)
    const cappedDocs = allRows.length > rows.length
    const results = claims.map((claim, index) => {
      if (Date.now() - startedAt > limits.stageTimeoutMs) {
        timedOut = true
        return {
          claimId: claim.claimId,
          supportDocs: [],
          equivalentDocs: [],
          contradictionDocs: [],
          contradictionFacts: [],
          evidence: 'none' as const,
        }
      }
      const equivalentDocs: string[] = []
      const contradictionDocs: string[] = []
      const contradictionFacts: string[] = []
      const supportDocs: string[] = []
      const claimNorm = normalizeText(claim.text)
      let docsScanned = 0
      for (const row of rows) {
        if (Date.now() - startedAt > limits.stageTimeoutMs) {
          timedOut = true
          break
        }
        docsScanned += 1
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
      const evidence = assessDocEvidence({
        equivalentDocs: equivalentDocs.length,
        supportDocs: supportDocs.length,
        contradictionDocs: contradictionDocs.length,
      })
      const result = {
        claimId: claim.claimId,
        supportDocs: dedup(supportDocs),
        equivalentDocs: dedup(equivalentDocs),
        contradictionDocs: dedup(contradictionDocs),
        contradictionFacts: dedup(contradictionFacts),
        evidence,
      }
      onProgress?.({
        stage: 'gather-evidence',
        itemsConsidered: claims.length,
        itemsCompleted: index + 1,
        itemsRemaining: Math.max(claims.length - (index + 1), 0),
        currentItem: claim.text,
        evidenceDocsScanned: docsScanned,
      })
      return result
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
        rationale:
          'No evidence found and no safe insertion target identified; skipped conservatively.',
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
            rationale:
              'Equivalent evidence exists but no safe target doc was resolved for insertion.',
            expectedPostcondition: 'No KB mutation should be required.',
          }
        }
        return {
          claimId: claim.claimId,
          action: 'append_existing',
          targetDocId,
          newFact: claim.text,
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
    if (
      e.supportDocs.length >= 2 &&
      isEvidenceAtLeast(e.evidence, 'moderate') &&
      e.contradictionDocs.length === 0
    ) {
      return {
        claimId: claim.claimId,
        action: 'noop',
        rationale:
          'Related supporting evidence already exists; skipping low-value duplicate mutation.',
        expectedPostcondition: 'No KB mutation should be required.',
      }
    }
    const contradictionFact = e.contradictionFacts[0]
    if (
      e.contradictionDocs.length > 0 &&
      isEvidenceAtLeast(claim.substance, 'moderate') &&
      isEvidenceAtLeast(e.evidence, 'strong') &&
      isSafeReplacementFact(contradictionFact)
    ) {
      if (!targetDocId) {
        return {
          claimId: claim.claimId,
          action: 'noop',
          rationale:
            'Contradiction detected, but no safe target doc was resolved for replacement insertion.',
          expectedPostcondition:
            'No KB mutation should be required without a clear target document.',
        }
      }
      return {
        claimId: claim.claimId,
        action: 'replace',
        targetDocId,
        oldFact: contradictionFact,
        newFact: claim.text,
        rationale:
          'Contradicting evidence exists; the claim is substantial and an equivalent doc was found.',
        expectedPostcondition:
          'Contradicting statement is removed/replaced and new claim is retrievable.',
      }
    }
    if (!isEvidenceAtLeast(claim.substance, 'moderate')) {
      return {
        claimId: claim.claimId,
        action: 'noop',
        rationale: 'Claim text is too thin to justify a write.',
        expectedPostcondition: 'No KB mutation should be required.',
      }
    }
    if (!targetDocId) {
      return {
        claimId: claim.claimId,
        action: 'noop',
        rationale:
          'No safe insertion target was resolved; skipped to avoid creating synthetic files.',
        expectedPostcondition: 'No KB mutation should be required.',
      }
    }
    return {
      claimId: claim.claimId,
      action: 'append_existing',
      targetDocId,
      newFact: claim.text,
      rationale: 'No strong equivalent found; append claim into best supporting document.',
      expectedPostcondition:
        'Target document contains inserted fact and retrieval should surface it.',
    }
  })
}

async function applyMutations(input: {
  base: string
  baseDir: string
  apply: boolean
  claims: RescanCandidateClaim[]
  stageTimeoutMs: number
  mutations: RescanPlannedMutation[]
  onProgress?: (progress: RescanApplyOrchestratorProgress) => void
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
  const indexer = new SqliteKbIndexer({ dbPath: path.join(input.baseDir, '.kb-index.sqlite') })
  const writtenDocIds: string[] = []
  const errors: string[] = []
  let appliedMutations = 0
  let noopMutations = 0

  try {
    for (const [index, mutation] of input.mutations.entries()) {
      if (Date.now() - startedAt > input.stageTimeoutMs) {
        timedOut = true
        errors.push(`apply stage timed out after ${input.stageTimeoutMs}ms`)
        break
      }
      const claim = claimById.get(mutation.claimId)
      if (!claim) continue
      if (mutation.action === 'noop') {
        noopMutations += 1
        input.onProgress?.({
          stage: 'apply-mutations',
          itemsConsidered: input.mutations.length,
          itemsCompleted: index + 1,
          itemsRemaining: Math.max(input.mutations.length - (index + 1), 0),
          currentItem: mutation.newFact ?? mutation.oldFact ?? mutation.claimId,
          appliedMutations,
          noopMutations,
        })
        continue
      }
      if (!input.apply) {
        input.onProgress?.({
          stage: 'apply-mutations',
          itemsConsidered: input.mutations.length,
          itemsCompleted: index + 1,
          itemsRemaining: Math.max(input.mutations.length - (index + 1), 0),
          currentItem: mutation.newFact ?? mutation.oldFact ?? mutation.claimId,
          appliedMutations,
          noopMutations,
        })
        continue
      }
      try {
        if (mutation.action === 'replace' && mutation.oldFact) {
          await invalidateFactTool(
            {
              oldFact: mutation.oldFact,
              replacementFact: '',
              preview: false,
              includeSessionLogs: false,
            },
            input.baseDir
          )
        }
        if (mutation.newFact) {
          const result = indexer.upsertFact({
            factText: mutation.newFact,
            triplet: placeholderTripletFromFactText(mutation.newFact),
            sourceKind: 'import_code',
            sourceRef: 'rescan',
            evidence: 'curated',
          })
          writtenDocIds.push(result.id)
        }
        appliedMutations += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${mutation.claimId}: ${message}`)
      }
      input.onProgress?.({
        stage: 'apply-mutations',
        itemsConsidered: input.mutations.length,
        itemsCompleted: index + 1,
        itemsRemaining: Math.max(input.mutations.length - (index + 1), 0),
        currentItem: mutation.newFact ?? mutation.oldFact ?? mutation.claimId,
        appliedMutations,
        noopMutations,
      })
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

function isSafeReplacementFact(value: string | undefined): value is string {
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

/**
 * How substantial a candidate claim's text is, by length. Length is a weak proxy
 * and always was — the old form dressed it as 0.35 / 0.55 / 0.7 / 0.85 and then
 * compared it against 0.6 and 0.65, so only the moderate/strong boundary ever
 * changed an outcome. The categories say that outright.
 */
function assessClaimSubstance(text: string): EvidenceLabel {
  const tokenCount = text.split(/\s+/).filter(Boolean).length
  if (tokenCount < 8) return 'none'
  if (tokenCount >= 20) return 'strong'
  if (tokenCount >= 12) return 'moderate'
  return 'weak'
}

/**
 * How strongly the existing KB already speaks to a claim.
 * `strong` — an equivalent doc already states it.
 * `moderate` — several docs support it and nothing contradicts it.
 * `weak` — some support exists.
 */
function assessDocEvidence(counts: {
  equivalentDocs: number
  supportDocs: number
  contradictionDocs: number
}): EvidenceLabel {
  if (counts.equivalentDocs > 0) return 'strong'
  if (counts.supportDocs >= 4 && counts.contradictionDocs === 0) return 'moderate'
  if (counts.supportDocs > 0) return 'weak'
  return 'none'
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

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value) return fallback
  return Math.max(1, Math.floor(value))
}

function pickTargetDocumentId(evidence: RescanEvidenceResult): string | undefined {
  return evidence.equivalentDocs[0] ?? evidence.supportDocs[0] ?? evidence.contradictionDocs[0]
}


async function buildPlanDiff(input: {
  base: string
  baseDir: string
  claims: RescanCandidateClaim[]
  mutations: RescanPlannedMutation[]
  stageTimeoutMs: number
  onProgress?: (progress: RescanApplyOrchestratorProgress) => void
}): Promise<string> {
  const startedAt = Date.now()
  const claimById = new Map(input.claims.map(claim => [claim.claimId, claim]))
  const indexer = new SqliteKbIndexer({ dbPath: path.join(input.baseDir, '.kb-index.sqlite') })
  try {
    const sections: string[] = []
    for (const [index, mutation] of input.mutations.entries()) {
      if (Date.now() - startedAt > input.stageTimeoutMs) break
      if (mutation.action === 'noop') continue
      const claim = claimById.get(mutation.claimId)
      if (!claim) continue

      if (mutation.action === 'append_existing' && mutation.targetDocId && mutation.newFact) {
        const before = indexer.getDocumentContent(mutation.targetDocId) ?? ''
        const after = `${before}${before.endsWith('\n') ? '' : '\n'}- ${mutation.newFact} (source: rescan)\n`
        sections.push(renderTextDiff(`docs/${mutation.targetDocId}.md`, before, after))
        continue
      }

      if (mutation.action === 'replace' && mutation.oldFact) {
        const preview = await invalidateFactTool(
          {
            oldFact: mutation.oldFact,
            replacementFact: '',
            preview: true,
            includeSessionLogs: false,
          },
          input.baseDir
        )
        for (const change of preview.changes.slice(0, 3)) {
          sections.push(
            renderTextDiff(
              `facts/${change.factId}.md`,
              change.before,
              change.after ?? change.before
            )
          )
        }
      }

      if (mutation.newFact && mutation.targetDocId) {
        const before = indexer.getDocumentContent(mutation.targetDocId) ?? ''
        const after = `${before}${before.endsWith('\n') ? '' : '\n'}- ${mutation.newFact} (source: rescan)\n`
        sections.push(renderTextDiff(`docs/${mutation.targetDocId}.md`, before, after))
      }
      input.onProgress?.({
        stage: 'preview-diff',
        itemsConsidered: input.mutations.length,
        itemsCompleted: index + 1,
        itemsRemaining: Math.max(input.mutations.length - (index + 1), 0),
        currentItem: mutation.targetDocId ?? claim.text,
      })
    }

    return renderDiffBundle(sections, '# No proposed content changes for this rescan plan.')
  } finally {
    indexer.close()
  }
}
