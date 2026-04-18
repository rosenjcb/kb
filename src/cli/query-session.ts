import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Message } from '../core/types'

interface QuerySessionTurn {
  question: string
  answer: string
  timestamp: number
}

interface QuerySession {
  turns: QuerySessionTurn[]
  updatedAt: number
}

const SESSION_FILE = 'query-session.json'
const MAX_TURNS = 4
const SESSION_TTL_MS = 30 * 60 * 1000

export async function loadQuerySessionMessages(baseDir: string): Promise<Message[]> {
  try {
    const raw = await readFile(path.join(baseDir, SESSION_FILE), 'utf8')
    const session: QuerySession = JSON.parse(raw)

    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
      return []
    }

    const messages: Message[] = []
    for (const turn of session.turns.slice(-MAX_TURNS)) {
      messages.push({ role: 'user', content: `Question: ${turn.question}` })
      messages.push({ role: 'assistant', content: turn.answer })
    }
    return messages
  } catch {
    return []
  }
}

export async function appendQuerySession(
  baseDir: string,
  question: string,
  answer: string
): Promise<void> {
  try {
    await mkdir(baseDir, { recursive: true })
    const sessionPath = path.join(baseDir, SESSION_FILE)

    let session: QuerySession = { turns: [], updatedAt: Date.now() }
    try {
      const raw = await readFile(sessionPath, 'utf8')
      const existing: QuerySession = JSON.parse(raw)
      if (Date.now() - existing.updatedAt <= SESSION_TTL_MS) {
        session = existing
      }
    } catch {
      // no existing session — start fresh
    }

    session.turns.push({ question, answer, timestamp: Date.now() })
    if (session.turns.length > MAX_TURNS) {
      session.turns.splice(0, session.turns.length - MAX_TURNS)
    }
    session.updatedAt = Date.now()

    await writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf8')
  } catch {
    // best-effort — never fail a query due to session write errors
  }
}
