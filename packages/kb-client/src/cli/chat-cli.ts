/**
 * Interactive chat session for the thin kb client.
 * Synthesis and retrieval always run on kb-server via `/v1/chat`.
 */

import { createInterface } from 'node:readline/promises'
import type { ToolExecutor } from '@kb/core/core/tool-registry.js'
import type { LLMProvider, Message } from '@kb/core/core/types.js'
import type { SlashInputContext } from '../tui/slash-command-registry.js'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { runRemoteChatSession } from './remote-commands.js'

export type { ChatSynthesisResult, ReadDocumentsResult } from '@kb/core/query/chat-synthesis.js'
export {
  buildChatTurnContent,
  buildToolQueryResult,
  CHAT_WEAK_RETRIEVAL_REFUSAL,
  lastRetrievalCheckpointConfidence,
  normalizeReadResult,
  runChatSynthesis,
  shouldRefuseChatTurnOnRetrieval,
} from '@kb/core/query/chat-synthesis.js'

export interface ChatSessionDeps {
  /** Unused on the thin client (server synthesizes). Kept for call-site compatibility. */
  llmProvider?: LLMProvider
  /** Unused on the thin client (server retrieves). Kept for call-site compatibility. */
  toolExecutor?: ToolExecutor
  mode?: CmdMode
  /** Local base name hint for connection context display only. */
  kbStorageDir?: string
  kbConfig?: KbConfig
  retrievalLimit?: number
  maxHistoryTurns?: number
  workspaceDir?: string
  /** @deprecated No longer used — routing is LLM-driven. Kept for API compatibility. */
  conversationalRetrieval?: boolean
  /** When true, request verbose orchestration from the server when supported. */
  verbose?: boolean
  onTurnComplete?: (turn: ChatTurnTrace) => void
  onSessionStart?: (sessionId: string) => void
  progressHeartbeatMs?: number
  progressNoticeMs?: number
  onBaseChanged?: () => void
}

export interface ChatReadOptions {
  slashContext?: SlashInputContext
  suggestions?: string[]
}

export interface ChatIO {
  read(prompt: string, opts?: ChatReadOptions): Promise<string | null>
  write(line: string): void
  error(line: string): void
  setProgressLine?(line: string | null): void
  close?(): void
}

export interface ChatTurnTrace {
  input: string
  resolvedQuery: string
  sourceIds: string[]
  answer: string
  retrievalMethod: string
}

const DOC_SESSION_TRANSCRIPT_MAX_CHARS = 12000

/** Serialize prior chat for `/docs generate` session prompts (tail-preserved, bounded). */
export function formatChatTranscriptForDocSession(
  messages: Message[],
  maxChars: number = DOC_SESSION_TRANSCRIPT_MAX_CHARS
): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const label = m.role === 'user' ? 'User' : 'Assistant'
    parts.push(`${label}:\n${m.content}`)
  }
  let body = parts.join('\n\n').trim()
  if (!body) return ''
  if (body.length > maxChars) {
    body = `…(earlier chat truncated)\n\n${body.slice(-(maxChars - 40))}`
  }
  return body
}

export function printChatHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('chat', mode)}`,
    '',
    'Usage:',
    `  ${cmd('chat', mode)} [--verbose] [--base <name>]`,
    '',
    'Flags:',
    '  --verbose   After each answer, also print summary / status / confidence orchestration rows (same as kb query --verbose). Must be passed before the session starts (CLI or TUI shell: chat --verbose).',
    '',
    'Interactive commands:',
    '  /help     Show chat commands',
    '  /session  Show session stats (turns, tokens, facts, timing)',
    '  /docs generate "<prompt>" …  Guided doc draft (questionnaire + review)',
    '  /clear    Clear session (fact pool + conversation history)',
    '  /exit     Exit chat mode',
    '',
    'Environment:',
    '  KB_CHAT_RETRIEVAL_MIN_CONFIDENCE  Last retrieval checkpoint must be ≥ this (0–1, default 0.45) or chat answers are skipped with an insufficient-evidence message.',
    '',
    'Examples:',
    `  ${cmd('chat', mode)}`,
  ].join('\n')
}

/** Always uses kb-server `/v1/chat` — there is no in-process client chat path. */
export async function runChatSession(
  deps: ChatSessionDeps,
  io: ChatIO = createTerminalChatIO()
): Promise<void> {
  return runRemoteChatSession(deps, io)
}

export function createTerminalChatIO(): ChatIO {
  const isTTY = process.stdin.isTTY === true
  const rl = createInterface({
    input: process.stdin,
    output: isTTY ? process.stdout : undefined,
    terminal: isTTY,
  })

  let interrupted = false
  const onSigint = () => {
    interrupted = true
    rl.close()
  }

  rl.on('SIGINT', onSigint)

  return {
    async read(prompt: string, _opts?: ChatReadOptions): Promise<string | null> {
      if (interrupted) return null

      try {
        return await rl.question(prompt)
      } catch {
        return null
      }
    },
    write(line: string) {
      console.log(line)
    },
    error(line: string) {
      console.error(line)
    },
    close() {
      rl.off('SIGINT', onSigint)
      try {
        rl.close()
      } catch {
        // Interface may already be closed.
      }
    },
  }
}
