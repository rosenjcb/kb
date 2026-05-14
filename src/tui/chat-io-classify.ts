import { WIRE_KEY, isOrchestrationMetaLine } from '../ui/orchestration-meta.js'

/** Tier identifiers for ChatIO.write() lines (see src/core/TUI.md — Output Model). */
export const CHAT_IO_CATEGORY = {
  /** T1 — orchestration metadata: immediate, permanent, grey. */
  META: 'meta',
  /** T3 — assistant content: accumulates in loading entry, committed once on read(). */
  ASSISTANT: 'assistant',
  /** Blank line — discard. */
  SKIP: 'skip',
} as const

export type ChatIOLineCategory = (typeof CHAT_IO_CATEGORY)[keyof typeof CHAT_IO_CATEGORY]

export interface ChatIOLineResult {
  category: ChatIOLineCategory
  /** Cleaned content — `assistant> ` prefix stripped for assistant lines. */
  content: string
}

const ASSISTANT_PREFIX = `${WIRE_KEY.ASSISTANT}> `

/**
 * Classify a raw line written via ChatIO.write() into a display category.
 *
 * Rules (in priority order):
 *  1. Orchestration wire lines (`key> value`) except `assistant>` → META (T1)
 *  2. Init/scan progress lines (`[init...]`, `[scan...]`) → META (T1)
 *  3. Blank lines → SKIP
 *  4. `assistant> <text>` → ASSISTANT (T3, prefix stripped)
 *  5. Anything else → ASSISTANT (direct KB or completion messages)
 */
export function classifyChatIOLine(line: string): ChatIOLineResult {
  if (isOrchestrationMetaLine(line)) {
    return { category: CHAT_IO_CATEGORY.META, content: line }
  }
  if (line.startsWith('[init') || line.startsWith('[scan')) {
    return { category: CHAT_IO_CATEGORY.META, content: line }
  }
  const clean = line.startsWith(ASSISTANT_PREFIX) ? line.slice(ASSISTANT_PREFIX.length) : line
  if (!clean.trim()) {
    return { category: CHAT_IO_CATEGORY.SKIP, content: '' }
  }
  return { category: CHAT_IO_CATEGORY.ASSISTANT, content: clean }
}
