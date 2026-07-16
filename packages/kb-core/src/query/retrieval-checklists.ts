/**
 * Retrieval-time answer checklists — reuse doc-gen questionnaires as coverage
 * dimensions for decompose / sufficiency / short-query expansion (#151).
 *
 * Source of truth: `src/prompts/doc-questionnaires/<DocType>.md` via
 * `loadQuestionnaire()`. Curator does not consume these; doc-gen does.
 */

import { loadQuestionnaire } from '../core/doc-questionnaire.js'
import type { DocType } from '../core/doc-taxonomy.js'

const RUNBOOK_RE =
  /\b(error|incident|outage|runbook|alert|failure|failed|exception|debug|fix|restart|recovery|rollback|ops|sev[0-9]|troubleshoot)\b/i
const DECISION_RE =
  /\b(why (?:did|do|was|were|is|are)|why we|chose|chosen|decision|trade-?off|alternative|instead of|versus|vs\.?)\b/i
const HOWTO_RE =
  /\b(how (?:do|would|can|should|might) (?:i|we|you|one)|how to|step[-\s]?by[-\s]?step|walk (?:me )?through|set[-\s]?up|get(?:ting)? started|procedure|workflow|steps (?:to|for))\b/i
const INTRODUCTION_RE =
  /\b(overview|what is this|what does this|high[-\s]?level|introduction|mental model|getting oriented)\b/i
const REFERENCE_RE =
  /\b(api|cli|flag|flags|option|options|parameter|parameters|env|environment variable|signature|type|interface|config|configuration)\b/i

/**
 * Cheap heuristic: map a user question to the DocType whose questionnaire best
 * describes the evidence shape we should retrieve. No LLM call.
 */
export function classifyQueryDocType(query: string): DocType {
  const q = query.trim()
  if (!q) return 'reference'
  if (RUNBOOK_RE.test(q)) return 'runbook'
  if (DECISION_RE.test(q)) return 'decision'
  if (HOWTO_RE.test(q)) return 'howto'
  if (INTRODUCTION_RE.test(q)) return 'introduction'
  if (REFERENCE_RE.test(q)) return 'reference'
  return 'reference'
}

/**
 * Format questionnaire items as retrieval coverage bullets.
 * Skips `documentTitle` (doc-writing only).
 */
export function formatRetrievalChecklist(docType: DocType): string {
  const items = loadQuestionnaire(docType).filter(item => item.key !== 'documentTitle')
  return items.map(item => `- ${item.key}: ${item.question}`).join('\n')
}

/** Classify + format a prompt block for decompose / sufficiency / expand. */
export function retrievalChecklistPromptBlock(query: string): {
  docType: DocType
  checklist: string
  promptBlock: string
} {
  const docType = classifyQueryDocType(query)
  const checklist = formatRetrievalChecklist(docType)
  const promptBlock = [
    `Answer type: ${docType}`,
    'Coverage checklist (retrieve / judge against dimensions relevant to the question — not every key blindly):',
    checklist,
  ].join('\n')
  return { docType, checklist, promptBlock }
}
