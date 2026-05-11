import { isOrchestrationMetaLine } from '../ui/orchestration-meta.js'

export type ChatIOLineCategory = 'meta' | 'assistant' | 'skip'

export interface ChatIOLineResult {
  category: ChatIOLineCategory
  /** Cleaned content — `assistant> ` prefix stripped for assistant lines. */
  content: string
}

/**
 * Classify a raw line written via ChatIO.write() into a display category.
 *
 * Rules (in priority order):
 *  1. Orchestration wire lines (`key> value`) except `assistant>` → meta
 *  2. Init/scan progress lines (`[init...]`, `[scan...]`) → meta
 *  3. Blank lines → skip
 *  4. `assistant> <text>` → assistant (prefix stripped)
 *  5. Anything else → assistant (direct KB or completion messages)
 */
export function classifyChatIOLine(line: string): ChatIOLineResult {
  if (isOrchestrationMetaLine(line)) {
    return { category: 'meta', content: line }
  }
  if (line.startsWith('[init') || line.startsWith('[scan')) {
    return { category: 'meta', content: line }
  }
  const clean = line.startsWith('assistant> ') ? line.slice('assistant> '.length) : line
  if (!clean.trim()) {
    return { category: 'skip', content: '' }
  }
  return { category: 'assistant', content: clean }
}
