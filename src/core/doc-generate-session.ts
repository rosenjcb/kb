import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DocType } from './doc-taxonomy'

export interface DocAnswerSlot {
  key: string
  question: string
  answer: string | null
  skipped?: boolean
}

export type DocGenerateSessionStatus = 'gathering' | 'ready' | 'finalized'

export interface DocGenerateSession {
  id: string
  prompt: string
  docType: DocType
  answers: DocAnswerSlot[]
  status: DocGenerateSessionStatus
  draftDocId?: string
  supportingFactIds?: string[]
  createdAt: number
  updatedAt: number
}

const SESSIONS_SUBDIR = 'doc-sessions'

export function docSessionsDir(baseDir: string): string {
  return path.join(baseDir, SESSIONS_SUBDIR)
}

function sessionPath(baseDir: string, id: string): string {
  return path.join(docSessionsDir(baseDir), `${id}.json`)
}

export async function loadSession(
  baseDir: string,
  id: string
): Promise<DocGenerateSession | null> {
  try {
    const raw = await readFile(sessionPath(baseDir, id), 'utf8')
    return JSON.parse(raw) as DocGenerateSession
  } catch {
    return null
  }
}

export async function saveSession(baseDir: string, session: DocGenerateSession): Promise<void> {
  await mkdir(docSessionsDir(baseDir), { recursive: true })
  session.updatedAt = Date.now()
  await writeFile(sessionPath(baseDir, session.id), JSON.stringify(session, null, 2), 'utf8')
}

export function createSessionRecord(input: {
  prompt: string
  docType: DocType
  questions: Array<{ key: string; question: string }>
}): DocGenerateSession {
  const now = Date.now()
  return {
    id: randomUUID(),
    prompt: input.prompt.trim(),
    docType: input.docType,
    answers: input.questions.map(q => ({
      key: q.key,
      question: q.question,
      answer: null,
    })),
    status: 'gathering',
    createdAt: now,
    updatedAt: now,
  }
}

export function firstPendingAnswerIndex(session: DocGenerateSession): number | null {
  const idx = session.answers.findIndex(
    slot => slot.answer === null && slot.skipped !== true
  )
  return idx === -1 ? null : idx
}

export function allAnswerSlotsResolved(session: DocGenerateSession): boolean {
  return session.answers.every(slot => slot.answer !== null || slot.skipped === true)
}

export function recomputeSessionStatus(session: DocGenerateSession): void {
  if (session.status === 'finalized') return
  session.status = allAnswerSlotsResolved(session) ? 'ready' : 'gathering'
}

export async function applyAnswer(
  baseDir: string,
  sessionId: string,
  text: string
): Promise<DocGenerateSession> {
  const session = await loadSession(baseDir, sessionId)
  if (!session) {
    throw new Error(`doc generate: session not found: ${sessionId}`)
  }
  if (session.status === 'finalized') {
    throw new Error('doc generate: session already finalized')
  }
  const idx = firstPendingAnswerIndex(session)
  if (idx === null) {
    throw new Error('doc generate: no pending question to answer')
  }
  session.answers[idx] = {
    ...session.answers[idx],
    answer: text.trim(),
  }
  recomputeSessionStatus(session)
  await saveSession(baseDir, session)
  return session
}

export async function applySkip(baseDir: string, sessionId: string): Promise<DocGenerateSession> {
  const session = await loadSession(baseDir, sessionId)
  if (!session) {
    throw new Error(`doc generate: session not found: ${sessionId}`)
  }
  if (session.status === 'finalized') {
    throw new Error('doc generate: session already finalized')
  }
  const idx = firstPendingAnswerIndex(session)
  if (idx === null) {
    throw new Error('doc generate: no pending question to skip')
  }
  session.answers[idx] = {
    ...session.answers[idx],
    skipped: true,
    answer: null,
  }
  recomputeSessionStatus(session)
  await saveSession(baseDir, session)
  return session
}

export async function markSessionFinalized(
  baseDir: string,
  sessionId: string,
  meta: { draftDocId: string; supportingFactIds: string[] }
): Promise<DocGenerateSession> {
  const session = await loadSession(baseDir, sessionId)
  if (!session) {
    throw new Error(`doc generate: session not found: ${sessionId}`)
  }
  session.status = 'finalized'
  session.draftDocId = meta.draftDocId
  session.supportingFactIds = meta.supportingFactIds
  await saveSession(baseDir, session)
  return session
}

export interface SessionListEntry {
  id: string
  status: DocGenerateSessionStatus
  docType: DocType
  promptPreview: string
  updatedAt: number
}

export async function listSessionSummaries(baseDir: string): Promise<SessionListEntry[]> {
  const dir = docSessionsDir(baseDir)
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const jsonFiles = names.filter(n => n.endsWith('.json'))
  const entries: SessionListEntry[] = []
  for (const name of jsonFiles) {
    const id = name.replace(/\.json$/i, '')
    const session = await loadSession(baseDir, id)
    if (!session) continue
    entries.push({
      id: session.id,
      status: session.status,
      docType: session.docType,
      promptPreview: session.prompt.slice(0, 120),
      updatedAt: session.updatedAt,
    })
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  return entries
}
