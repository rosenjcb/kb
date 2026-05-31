import {
  acceptDraft,
  answerCurrent,
  produceInitialDraft,
  produceRevisedDraft,
  skipCurrent,
  startGenerationSession,
} from '../core/doc-generate-orchestrator'
import { firstPendingAnswerIndex, loadSession } from '../core/doc-generate-session'
import { colorizeUnifiedDiff } from '../core/git-diff-preview'
import type { LLMProvider } from '../core/types'
import type { SlashInputContext } from '../tui/slash-command-registry.js'
import { parseShellArgs } from '../tui/runner.js'
import type { Printer } from '../ui/printer'
import { DocsGenerateError, parseDocsGenerateCommand } from './docs-generate-cli'
import { promptUserDocSections } from './docs-generate-sections'
import type { KbConfig } from './kb-config'

export async function runDocsGenerateChatFlow(input: {
  read: (prompt: string, opts?: { slashContext?: SlashInputContext }) => Promise<string | null>
  writeError: (line: string) => void
  printer: Printer
  llm: LLMProvider
  kbStorageDir: string
  config: KbConfig
  /** Text after `/docs generate ` (may be empty). */
  slashRest: string
  /** Recent KB chat turns (bounded); persisted on session for every draft/revision prompt. */
  chatTranscript?: string
}): Promise<void> {
  const { read, writeError, printer, llm, kbStorageDir, config } = input
  const tail = input.slashRest.trim()
  const argv = tail ? parseShellArgs(tail) : []

  let parsed: ReturnType<typeof parseDocsGenerateCommand>
  try {
    parsed = parseDocsGenerateCommand(argv)
  } catch (e) {
    const msg =
      e instanceof DocsGenerateError ? e.message : e instanceof Error ? e.message : String(e)
    printer.chatAssistant(msg)
    return
  }

  if (parsed.mode !== 'start') {
    printer.chatAssistant(
      'In chat, use: /docs generate "<prompt>" [--type howto|...] [--limit N]. Resume/list/show are CLI-only here.'
    )
    return
  }

  let prompt = parsed.prompt.trim()
  if (!prompt) {
    const p = await read('docs-generate prompt> ')
    if (p === null) {
      printer.chatAssistant('Cancelled.')
      return
    }
    prompt = p.trim()
    if (!prompt) {
      printer.chatAssistant('Empty prompt — cancelled.')
      return
    }
  }

  const sectionsResult = await promptUserDocSections({
    writeLine: msg => printer.chatAssistant(msg),
    readLine: (prompt, opts) => read(prompt, opts),
  })
  if (sectionsResult === 'cancel') {
    printer.chatAssistant('Cancelled.')
    return
  }
  const sections = sectionsResult === 'skip' ? undefined : sectionsResult

  printer.chatAssistant('Starting document session…')
  const started = await startGenerationSession({
    baseDir: kbStorageDir,
    prompt,
    type: parsed.type,
    config,
    deps: { llm },
    chatTranscript: input.chatTranscript?.trim() || undefined,
    sections,
  })
  const sessionId = started.sessionId
  printer.chatAssistant(`Session ${sessionId} (${started.docType}).`)

  while (true) {
    const session = await loadSession(kbStorageDir, sessionId)
    if (!session) {
      writeError('Session lost.')
      return
    }
    if (session.status === 'ready' || session.status === 'awaiting_review') break

    const idx = firstPendingAnswerIndex(session)
    const q = idx !== null ? session.answers[idx] : undefined
    if (!q) {
      writeError('No pending question.')
      return
    }
    const hint = '(answer | /skip | /cancel)'
    const line = await read(`[${q.key}] ${q.question} ${hint}\n> `, {
      slashContext: 'docs-generate-question',
    })
    if (line === null || line.trim() === '/cancel') {
      printer.chatAssistant('Cancelled document session (session file kept).')
      return
    }
    const t = line.trim()
    if (t === '/skip') {
      await skipCurrent(kbStorageDir, sessionId)
      printer.chatAssistant('Skipped.')
    } else {
      await answerCurrent(kbStorageDir, sessionId, t)
    }
  }

  printer.chatAssistant('Drafting (LLM + references)…')
  const draft = await produceInitialDraft({
    baseDir: kbStorageDir,
    sessionId,
    llm,
    factLimit: parsed.factLimit,
  })
  printer.chatAssistant(`Draft revision ${draft.revision} (${draft.supportingFactCount} facts).`)
  printer.chatAssistant('--- draft body ---')
  printer.chatAssistant(draft.content)

  while (true) {
    const line = await read('review> (/accept | /reject <feedback> | /cancel)\n> ', {
      slashContext: 'docs-generate-review',
    })
    if (line === null) return
    const t = line.trim()
    if (!t || t === '/cancel') {
      printer.chatAssistant('Left review loop (draft saved; use CLI --accept when ready).')
      return
    }
    const lower = t.toLowerCase()
    if (lower === '/accept') {
      const out = await acceptDraft({ baseDir: kbStorageDir, sessionId, deps: { llm } })
      printer.chatAssistant(`Accepted. Document id: ${out.document.id}`)
      return
    }
    let feedback: string | undefined
    if (lower.startsWith('/reject ')) {
      feedback = t.slice('/reject '.length).trim()
    }
    if (!feedback) {
      printer.chatAssistant('Use /accept, /reject <feedback>, or /cancel.')
      continue
    }
    printer.chatAssistant('Revising…')
    const rev = await produceRevisedDraft({
      baseDir: kbStorageDir,
      sessionId,
      llm,
      feedback,
      factLimit: parsed.factLimit,
    })
    printer.chatAssistant(`Revision ${rev.revision} (from ${rev.fromRevision}).`)
    printer.chatAssistant(colorizeUnifiedDiff(rev.diff, { color: true }))
  }
}
