import path from 'node:path'
import type { DocType } from './doc-taxonomy'
import { DOC_TYPES, isDocType } from './doc-taxonomy'
import { appendReferencesFooter } from './doc-references-footer'
import {
  acceptSessionDraft,
  applyAnswer,
  applySkip,
  createSessionRecord,
  firstPendingAnswerIndex,
  loadSession,
  saveSession,
  setSessionDraft,
  type DocGenerateDraft,
  type DocGenerateSession,
} from './doc-generate-session'
import { deriveDocumentTitle } from './doc-generate-title'
import { loadQuestionnaire } from './doc-questionnaire'
import { buildDocgenFactContext, searchSupportingFacts } from './doc-supporting-facts'
import type { KbConfig } from '../cli/kb-config.js'
import { createLLMProviderFromConfig } from '../cli/kb-config.js'
import { loadPrompt } from '../prompts/loader'
import type { LLMProvider } from './types'
import type { WriteDocumentResult } from '../tools/document-writer'
import { SqliteDocumentWriter } from '../tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../tools/sqlite-kb-index'

export interface DocGenerateOrchestratorDeps {
  llm?: LLMProvider
  documentWriter?: Pick<SqliteDocumentWriter, 'writeDocument'>
}

function buildFactSearchQuery(session: DocGenerateSession): string {
  const parts = [session.prompt]
  for (const slot of session.answers) {
    if (slot.answer?.trim()) {
      parts.push(`${slot.key}: ${slot.answer}`)
    }
  }
  return parts.join('\n')
}

async function classifyDocType(
  config: KbConfig,
  deps: DocGenerateOrchestratorDeps,
  prompt: string
): Promise<DocType> {
  const llm = deps.llm ?? createLLMProviderFromConfig(config)
  if (!llm) {
    throw new Error('doc generate: no LLM provider configured')
  }
  const systemPrompt = loadPrompt('doc-classify.md')
  const res = await llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: `User prompt:\n\n${prompt}` }],
    maxTokens: 32,
    temperature: 0,
  })
  return parseClassifierDocType(res.text)
}

function parseClassifierDocType(text: string): DocType {
  const line = text
    .trim()
    .split('\n')[0]
    .trim()
    .replace(/[`'"]+/g, '')
    .replace(/[.?!]+$/g, '')
    .toLowerCase()
  if (isDocType(line)) return line
  const first = line.split(/\s+/)[0] ?? ''
  if (isDocType(first)) return first
  for (const t of DOC_TYPES) {
    if (line.includes(t)) return t
  }
  return 'reference'
}

function formatChatTranscriptBlock(session: DocGenerateSession): string[] {
  const tx = session.chatTranscript?.trim()
  if (!tx) return []
  return [
    '',
    'KB chat transcript (user phrasing and constraints from before this doc run; must not contradict structured answers or invent facts):',
    tx,
  ]
}

async function draftDocumentBody(
  llm: LLMProvider,
  session: DocGenerateSession,
  factContextMarkdown: string
): Promise<string> {
  const systemPrompt = loadPrompt('doc-draft-system.md')
  const lines = [
    `Document type: ${session.docType}`,
    '',
    'Original user prompt:',
    session.prompt,
    '',
    'Structured answers:',
    ...session.answers.map(slot => {
      const status = slot.skipped ? '(skipped)' : ''
      const body = slot.skipped ? '' : slot.answer ?? ''
      return `- **${slot.key}** ${status}: ${body}`.trimEnd()
    }),
    ...formatChatTranscriptBlock(session),
    '',
    factContextMarkdown,
  ]
  const res = await llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
    maxTokens: 8192,
    temperature: 0.35,
  })
  return res.text.trim()
}

function buildPriorReviewFeedbackLines(session: DocGenerateSession): string[] {
  const rows = session.revisions?.map(r => r.feedback?.trim()).filter(Boolean) ?? []
  if (rows.length === 0) return []
  const lines = ['', 'Prior reviewer instructions (chronological; honor all that still apply; later rounds override earlier on conflict):']
  for (let i = 0; i < rows.length; i += 1) {
    lines.push(`${i + 1}. ${rows[i]}`)
  }
  return lines
}

async function draftDocumentRevision(
  llm: LLMProvider,
  session: DocGenerateSession,
  priorBody: string,
  feedback: string,
  factContextMarkdown: string
): Promise<string> {
  const systemPrompt = loadPrompt('doc-edit-system.md')
  const user = [
    `Document type: ${session.docType}`,
    '',
    'Original user prompt:',
    session.prompt,
    '',
    'Structured answers:',
    ...session.answers.map(slot => {
      const status = slot.skipped ? '(skipped)' : ''
      const body = slot.skipped ? '' : slot.answer ?? ''
      return `- **${slot.key}** ${status}: ${body}`.trimEnd()
    }),
    ...buildPriorReviewFeedbackLines(session),
    '',
    'Latest reviewer instruction (apply on top of the prior list):',
    feedback,
    ...formatChatTranscriptBlock(session),
    '',
    factContextMarkdown,
    '',
    'Current draft body (revise in place; preserve unchanged text verbatim):',
    priorBody,
  ].join('\n')
  const res = await llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: user }],
    maxTokens: 8192,
    temperature: 0.25,
  })
  return res.text.trim()
}

export async function startGenerationSession(input: {
  baseDir: string
  prompt: string
  type?: DocType
  config: KbConfig
  deps?: DocGenerateOrchestratorDeps
  /** When starting from chat, persist for draft + all revision prompts. */
  chatTranscript?: string
}): Promise<{
  status: DocGenerateSession['status']
  sessionId: string
  docType: DocType
  questionIndex: number | null
  question: string | undefined
  key: string | undefined
}> {
  const docType =
    input.type ?? (await classifyDocType(input.config, input.deps ?? {}, input.prompt))
  const items = loadQuestionnaire(docType)
  const session = createSessionRecord({
    prompt: input.prompt,
    docType,
    questions: items,
  })
  const tx = input.chatTranscript?.trim()
  if (tx) {
    session.chatTranscript = tx
  }
  await saveSession(input.baseDir, session)
  const idx = firstPendingAnswerIndex(session)
  const q = idx !== null ? session.answers[idx] : undefined
  return {
    status: session.status,
    sessionId: session.id,
    docType: session.docType,
    questionIndex: idx,
    question: q?.question,
    key: q?.key,
  }
}

export async function answerCurrent(
  baseDir: string,
  sessionId: string,
  text: string
): Promise<DocGenerateSession> {
  return applyAnswer(baseDir, sessionId, text)
}

export async function skipCurrent(baseDir: string, sessionId: string): Promise<DocGenerateSession> {
  return applySkip(baseDir, sessionId)
}

export async function produceInitialDraft(input: {
  baseDir: string
  sessionId: string
  llm: LLMProvider
  factLimit?: number
}): Promise<{
  status: 'awaiting_review'
  sessionId: string
  revision: number
  content: string
  contentWithFooter: string
  supportingFactCount: number
  nextActions: [string, string]
}> {
  const session = await loadSession(input.baseDir, input.sessionId)
  if (!session) {
    throw new Error(`doc generate: session not found: ${input.sessionId}`)
  }
  if (session.status !== 'ready') {
    throw new Error(
      `doc generate: session not ready for finalize (status=${session.status}). Answer or skip all questions first.`
    )
  }

  const indexer = new SqliteKbIndexer({ dbPath: path.join(input.baseDir, '.kb-index.sqlite') })
  try {
    const facts = searchSupportingFacts(
      indexer,
      buildFactSearchQuery(session),
      input.factLimit ?? 20
    )
    if (facts.length === 0) {
      throw new Error(
        'doc generate: no supporting facts in KB match this prompt. Submit facts with kb submit or broaden answers, then retry.'
      )
    }
    const factBlock = buildDocgenFactContext(facts)
    const draftBody = await draftDocumentBody(input.llm, session, factBlock)
    const fullContent = appendReferencesFooter(draftBody, facts)
    const now = Date.now()
    const draft: DocGenerateDraft = {
      revision: 1,
      content: draftBody,
      contentWithFooter: fullContent,
      supportingFactIds: facts.map(f => f.id),
      createdAt: now,
    }
    await setSessionDraft(input.baseDir, input.sessionId, draft)
    return {
      status: 'awaiting_review',
      sessionId: session.id,
      revision: 1,
      content: draftBody,
      contentWithFooter: fullContent,
      supportingFactCount: facts.length,
      nextActions: ['--accept', '--reject "<feedback>"'],
    }
  } finally {
    indexer.close()
  }
}

export async function produceRevisedDraft(input: {
  baseDir: string
  sessionId: string
  llm: LLMProvider
  feedback: string
  factLimit?: number
}): Promise<{
  status: 'awaiting_review'
  sessionId: string
  revision: number
  fromRevision: number
  diff: string
  contentWithFooter: string
  supportingFactCount: number
}> {
  const session = await loadSession(input.baseDir, input.sessionId)
  if (!session) {
    throw new Error(`doc generate: session not found: ${input.sessionId}`)
  }
  if (session.status !== 'awaiting_review' || !session.draft) {
    throw new Error(
      `doc generate: session not awaiting review (status=${session.status}). Use --finalize first.`
    )
  }

  const prior = session.draft
  const indexer = new SqliteKbIndexer({ dbPath: path.join(input.baseDir, '.kb-index.sqlite') })
  try {
    const facts = searchSupportingFacts(
      indexer,
      buildFactSearchQuery(session),
      input.factLimit ?? 20
    )
    if (facts.length === 0) {
      throw new Error(
        'doc generate: no supporting facts in KB match this prompt. Submit facts with kb submit or broaden answers, then retry.'
      )
    }
    const factBlock = buildDocgenFactContext(facts)
    const nextBody = await draftDocumentRevision(
      input.llm,
      session,
      prior.content,
      input.feedback.trim(),
      factBlock
    )
    const fullContent = appendReferencesFooter(nextBody, facts)
    const now = Date.now()
    const nextRev = prior.revision + 1
    const nextDraft: DocGenerateDraft = {
      revision: nextRev,
      content: nextBody,
      contentWithFooter: fullContent,
      supportingFactIds: facts.map(f => f.id),
      feedback: input.feedback.trim(),
      createdAt: now,
    }
    await setSessionDraft(input.baseDir, input.sessionId, nextDraft)
    const updated = await loadSession(input.baseDir, input.sessionId)
    const lastPatch = updated?.revisions?.[updated.revisions.length - 1]
    const diff = lastPatch?.diff ?? ''
    return {
      status: 'awaiting_review',
      sessionId: session.id,
      revision: nextRev,
      fromRevision: prior.revision,
      diff,
      contentWithFooter: fullContent,
      supportingFactCount: facts.length,
    }
  } finally {
    indexer.close()
  }
}

export async function acceptDraft(input: {
  baseDir: string
  sessionId: string
  deps?: DocGenerateOrchestratorDeps
}): Promise<{
  document: WriteDocumentResult
  sessionId: string
  revision: number
}> {
  const session = await loadSession(input.baseDir, input.sessionId)
  if (!session) {
    throw new Error(`doc generate: session not found: ${input.sessionId}`)
  }
  if (session.status !== 'awaiting_review' || !session.draft) {
    throw new Error(
      `doc generate: nothing to accept (status=${session.status}). Use --finalize first.`
    )
  }
  if (session.draft.supportingFactIds.length === 0) {
    throw new Error(
      'doc generate: cannot accept draft with zero supporting facts (KB grounding required).'
    )
  }

  const title = deriveDocumentTitle(session)
  const writer =
    input.deps?.documentWriter ?? new SqliteDocumentWriter({ baseDir: input.baseDir })
  const ownsWriter = !input.deps?.documentWriter
  try {
    const result = await writer.writeDocument({
      title,
      content: session.draft.contentWithFooter,
      type: session.docType,
      tags: ['docs-generate'],
    })

    await acceptSessionDraft(input.baseDir, input.sessionId, { draftDocId: result.id })
    return {
      document: result,
      sessionId: session.id,
      revision: session.draft.revision,
    }
  } finally {
    if (ownsWriter && writer instanceof SqliteDocumentWriter) {
      writer.close()
    }
  }
}
