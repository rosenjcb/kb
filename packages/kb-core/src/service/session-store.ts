/**
 * In-memory chat session store.
 *
 * Holds per-session conversation history (`Message[]`) with TTL eviction and a
 * turn cap. Suitable for single-instance hosting; sessions are lost on instance
 * recycle and not shared across instances. A Redis/Firestore-backed store can
 * replace this later behind the same interface when multi-instance durability is
 * required.
 */

import type { Message } from '@kb/core/core/types.js'

export interface SessionStoreOptions {
  /** Max conversation turns retained (a turn = one user + one assistant message). */
  maxTurns?: number
  /** Idle TTL before a session is evicted (ms). */
  ttlMs?: number
}

interface SessionEntry {
  messages: Message[]
  lastAccess: number
}

const DEFAULT_MAX_TURNS = 8
const DEFAULT_TTL_MS = 30 * 60 * 1000 // 30 minutes

export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly maxMessages: number
  private readonly ttlMs: number

  constructor(options: SessionStoreOptions = {}) {
    this.maxMessages = (options.maxTurns ?? DEFAULT_MAX_TURNS) * 2
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  /** Return a copy of the session history, evicting it first if expired. */
  get(sessionId: string): Message[] {
    this.evictExpired()
    const entry = this.sessions.get(sessionId)
    if (!entry) return []
    entry.lastAccess = Date.now()
    return [...entry.messages]
  }

  /** Append a user/assistant exchange and trim to the turn cap. */
  append(sessionId: string, userMessage: Message, assistantMessage: Message): void {
    const entry = this.sessions.get(sessionId) ?? { messages: [], lastAccess: Date.now() }
    entry.messages.push(userMessage, assistantMessage)
    if (entry.messages.length > this.maxMessages) {
      entry.messages = entry.messages.slice(-this.maxMessages)
    }
    entry.lastAccess = Date.now()
    this.sessions.set(sessionId, entry)
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  size(): number {
    this.evictExpired()
    return this.sessions.size
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs
    for (const [id, entry] of this.sessions) {
      if (entry.lastAccess < cutoff) this.sessions.delete(id)
    }
  }
}
