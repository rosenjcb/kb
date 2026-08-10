import { existsSync } from 'node:fs'
import path from 'node:path'
import { Box, useApp, useInput } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveEffectiveBaseDir } from '@kb/core/storage/base-selection.js'
import { resolveDisplayBase } from '../cli/remote-commands.js'
import type { ChatIO, ChatReadOptions } from '../cli/chat-cli.js'
import { runChatSession } from '../cli/chat-cli.js'
import { performClientUninstall } from '@kb/core/cli/release-uninstall.js'
import { uninitializedBaseNotice } from '@kb/core/config/cli-prerequisites.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { classifyChatReadPromptKind, shouldStartChatPending } from './chat-read-kind.js'
import { classifyChatIOLine } from './chat-io-classify.js'
import { HistoryPane } from './components/HistoryPane.js'
import { InputBar } from './components/InputBar.js'
import { StatusBar } from './components/StatusBar.js'
import { SuggestionsBar } from './components/SuggestionsBar.js'
import { isOutputCommandName } from '@kb/core/commands/command-catalog.js'
import { partitionShellOutputForTui } from './partition-shell-output.js'
import { runCommandForTui, parseShellArgs } from './runner.js'
import {
  applySelectedSuggestion,
  clampSuggestionIndex,
  getSlashCommandSuggestions,
  normalizeSlashCommandArgs,
  sanitizeSlashInput,
  type SlashInputContext,
} from './slash-commands.js'
import type { HistoryEntry, TuiMode } from './types.js'

/**
 * Commands handled inline as transcript-only output. Derived from the shared command
 * catalog (`tuiKind: 'output'`) so this gate can never drift from the slash registry —
 * the exact bug that made `/entities` and `/session` silently fall through to chat.
 */
function isOutputOnlyCommand(first: string): boolean {
  return isOutputCommandName(first)
}

interface Props {
  config: KbConfig
  startupNotices?: string[]
  serverHost?: string
  /** Base resolved by the CLI before launch, so the status bar starts correct. */
  initialBaseName?: string
  /** Whether initialBaseName is the server's own default base (no local active base). */
  initialBaseIsServerDefault?: boolean
}

export function App({
  config,
  startupNotices = [],
  serverHost = 'localhost',
  initialBaseName,
  initialBaseIsServerDefault,
}: Props) {
  const { exit } = useApp()

  const mode: TuiMode = 'chat'
  const [history, setHistory] = useState<HistoryEntry[]>([
    { id: 'welcome', type: 'banner', content: '' },
  ])
  const [inputValue, setInputValue] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [baseName, setBaseName] = useState(initialBaseName ?? '…')
  const [baseIsServerDefault, setBaseIsServerDefault] = useState(
    initialBaseIsServerDefault ?? false
  )
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)
  const [baseResolved, setBaseResolved] = useState(false)

  const [pendingConfirm, setPendingConfirm] = useState<{
    question: string
    onConfirm: () => Promise<void>
  } | null>(null)
  const [chatInputHint, setChatInputHint] = useState('')
  const [slashContext, setSlashContext] = useState<SlashInputContext>('idle')
  const [inlineSuggestions, setInlineSuggestions] = useState<string[]>([])

  const chatInputResolverRef = useRef<((v: string | null) => void) | null>(null)
  const chatPendingEntryIdRef = useRef<string | null>(null)
  const chatResponseIdRef = useRef<string | null>(null)
  const chatResponseBufRef = useRef<string>('')
  const chatReadKindRef = useRef<'chat' | 'command'>('chat')
  const chatSessionIdRef = useRef<string | undefined>(undefined)
  const storageDirRef = useRef<string>('')
  const entryCounterRef = useRef(0)
  const chatStartedRef = useRef(false)

  const addEntry = useCallback((entry: Omit<HistoryEntry, 'id'>): string => {
    const id = `e${++entryCounterRef.current}`
    setHistory(prev => [...prev, { ...entry, id }])
    return id
  }, [])

  const startupNoticesRef = useRef(startupNotices)
  useEffect(() => {
    for (const notice of startupNoticesRef.current) {
      addEntry({ type: 'info', content: notice })
    }
  }, [addEntry])

  const updateEntry = useCallback((id: string, patch: Partial<Omit<HistoryEntry, 'id'>>) => {
    setHistory(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)))
  }, [])

  const removeEntry = useCallback((id: string) => {
    setHistory(prev => prev.filter(e => e.id !== id))
  }, [])

  const startChatPending = useCallback(() => {
    if (chatPendingEntryIdRef.current) return
    chatPendingEntryIdRef.current = addEntry({
      type: 'chat-meta',
      content: 'thinking...',
      loading: true,
    })
  }, [addEntry])

  const stopChatPending = useCallback(() => {
    const pendingId = chatPendingEntryIdRef.current
    if (!pendingId) return
    chatPendingEntryIdRef.current = null
    removeEntry(pendingId)
  }, [removeEntry])

  const finalizeChatResponse = useCallback(() => {
    if (!chatResponseIdRef.current) return
    updateEntry(chatResponseIdRef.current, { loading: false })
    chatResponseIdRef.current = null
    chatResponseBufRef.current = ''
  }, [updateEntry])

  // Single base resolver for the status bar: the displayed name comes from the same
  // `resolveDisplayBase` the CLI banner uses — the active base (also sent on the wire as
  // `X-KB-Base`) or, when none is selected locally, the server's own default base. So the
  // bar can never disagree with the base kb-server actually serves, and never shows a bare
  // "(none)" when the server is in fact serving its default. The local dir (best effort)
  // is only used for the uninitialized-index notice.
  const resolveBaseState = useCallback(async () => {
    const display = await resolveDisplayBase(config).catch(() => ({
      name: undefined,
      isServerDefault: false,
    }))
    let dir = ''
    try {
      dir = (await resolveEffectiveBaseDir()).baseDir
    } catch {
      // No local base dir — remote base or none selected.
    }
    return { name: display.name ?? '', isServerDefault: display.isServerDefault, dir }
  }, [config])

  const refreshBase = useCallback(() => {
    return resolveBaseState()
      .then(({ name, isServerDefault, dir }) => {
        storageDirRef.current = dir
        setBaseName(name)
        setBaseIsServerDefault(isServerDefault)
      })
      .catch(() => {})
  }, [resolveBaseState])

  useEffect(() => {
    resolveBaseState()
      .then(({ name, isServerDefault, dir }) => {
        storageDirRef.current = dir
        setBaseName(name)
        setBaseIsServerDefault(isServerDefault)
        setBaseResolved(true)
      })
      .catch(() => {
        storageDirRef.current = ''
        setBaseName('')
        setBaseIsServerDefault(false)
        setBaseResolved(true)
      })
  }, [resolveBaseState])

  const startChatSession = useCallback(
    (opts: { verbose?: boolean } = {}) => {
      const verbose = opts.verbose === true
      // Base, LLM provider, and retrieval all live server-side.
      const storageDir = storageDirRef.current

      setChatInputHint('')
      setSlashContext('idle')

      const chatIO: ChatIO = {
        async read(prompt: string, opts?: ChatReadOptions): Promise<string | null> {
          // Commit any in-flight response before we wait for user input.
          finalizeChatResponse()
          const normalized = prompt.replace(/\r/g, '').trim()
          const readKind = classifyChatReadPromptKind(prompt)
          const firstLine =
            normalized
              .split('\n')
              .find(l => l.trim().length > 0)
              ?.trim() ?? ''
          const isIdleReadPrompt = readKind === 'chat'
          if (normalized.length > 0 && !isIdleReadPrompt) {
            const oneLine = normalized.replace(/\s+/g, ' ').trim()
            const clipped = oneLine.length > 500 ? `${oneLine.slice(0, 497)}…` : oneLine
            addEntry({ type: 'info', content: clipped })
            const hint = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
            setChatInputHint(hint)
          }
          chatReadKindRef.current = readKind
          setSlashContext(opts?.slashContext ?? 'idle')
          setInlineSuggestions(opts?.suggestions ?? [])
          return new Promise<string | null>(resolve => {
            chatInputResolverRef.current = (value: string | null) => {
              chatInputResolverRef.current = null
              chatReadKindRef.current = 'chat'
              setChatInputHint('')
              setSlashContext('idle')
              setInlineSuggestions([])
              resolve(value)
            }
          })
        },
        write(line: string) {
          stopChatPending()
          const { category, content } = classifyChatIOLine(line)
          if (category === 'meta') {
            // Flush any in-flight assistant response first so the answer entry is
            // committed (loading→false) before these meta entries are appended.
            // Without this, <Static> sees meta entries committed before the answer
            // and inserts the answer mid-stream when finalized, causing Ink to
            // re-render tail entries (duplicate timing lines) and drop the answer.
            finalizeChatResponse()
            addEntry({ type: 'chat-meta', content: line })
          } else if (category === 'assistant') {
            // Content accumulates in a single loading entry per response turn.
            // The spinner shows the last few lines in grey; full text commits on read().
            if (!chatResponseIdRef.current) {
              chatResponseBufRef.current = content
              chatResponseIdRef.current = addEntry({ type: 'chat-assistant', content, loading: true })
            } else {
              const buf = `${chatResponseBufRef.current}\n${content}`
              chatResponseBufRef.current = buf
              updateEntry(chatResponseIdRef.current, { content: buf })
            }
          }
          // 'skip': blank line — do nothing
        },
        error(line: string) {
          finalizeChatResponse()
          stopChatPending()
          addEntry({ type: 'error', content: line })
        },
        setProgressLine(line: string | null) {
          // Stream the server's reasoning/progress into the pending "thinking..." spinner so
          // the user sees live status instead of a frozen "thinking...". Falls back to the
          // generic label when a turn stage clears its progress (null/empty).
          const pendingId = chatPendingEntryIdRef.current
          if (!pendingId) return
          const status = line?.trim()
          updateEntry(pendingId, { content: status ? status : 'thinking...' })
        },
      }

      runChatSession(
        {
          mode: 'tui',
          kbStorageDir: storageDir || undefined,
          kbConfig: config,
          verbose,
          onBaseChanged: refreshBase,
          onSessionStart: (id) => { chatSessionIdRef.current = id },
        },
        chatIO
      )
        .then(() => {
          finalizeChatResponse()
          stopChatPending()
          setChatInputHint('')
          exit()
        })
        .catch(err => {
          finalizeChatResponse()
          stopChatPending()
          setChatInputHint('')
          const message = err instanceof Error ? err.message : String(err)
          addEntry({ type: 'error', content: `Chat error: ${message}` })
          // Restart after crash
          chatStartedRef.current = false
          startChatSession(opts)
        })
    },
    [config, addEntry, updateEntry, stopChatPending, finalizeChatResponse, refreshBase, exit]
  )

  // Start chat session once after base dir resolves
  useEffect(() => {
    if (!baseResolved || chatStartedRef.current) return
    chatStartedRef.current = true
    resolveBaseState()
      .then(({ name, dir }) => {
        const hasIndex = dir ? existsSync(path.join(dir, '.kb-index.sqlite')) : false
        if (!hasIndex) {
          addEntry({ type: 'info', content: uninitializedBaseNotice(name || '(none)') })
        }
        startChatSession()
      })
      .catch(() => startChatSession())
  }, [baseResolved, startChatSession, addEntry, resolveBaseState])

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      const pendingInput = chatInputResolverRef.current
      if (!trimmed) {
        if (pendingInput) {
          setInputValue('')
          chatInputResolverRef.current = null
          setSlashContext('idle')
          setInlineSuggestions([])
          pendingInput('')
        }
        return
      }
      setInputValue('')

      // ── Pending confirmation (base/docs delete) ──
      if (pendingConfirm) {
        addEntry({ type: 'chat-you', content: trimmed })
        const { onConfirm } = pendingConfirm
        setPendingConfirm(null)
        if (trimmed.toLowerCase() === 'y' || trimmed.toLowerCase() === 'yes') {
          setIsRunning(true)
          const resultId = addEntry({ type: 'result', content: '', loading: true })
          try {
            await onConfirm()
            updateEntry(resultId, { content: 'Done.', loading: false })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            updateEntry(resultId, { type: 'error', content: message, loading: false })
          } finally {
            setIsRunning(false)
          }
        } else {
          addEntry({ type: 'info', content: 'Aborted.' })
        }
        return
      }

      // ── Always-intercepted TUI commands ──
      if (trimmed === '/exit' || trimmed === '/quit') {
        addEntry({ type: 'chat-you', content: trimmed })
        const resolver = chatInputResolverRef.current
        if (resolver) { chatInputResolverRef.current = null; resolver(null) }
        exit()
        return
      }

      if (trimmed === '/clear') {
        // The finished session stays snoopable in the run logs; point the user at it.
        const clearedSession = chatSessionIdRef.current
        chatSessionIdRef.current = undefined
        setHistory([{ id: 'welcome', type: 'banner', content: '' }])
        if (clearedSession) {
          addEntry({
            type: 'info',
            content: 'Session cleared. Snoop it later with /session (or kb logs show <runId>).',
          })
        }
        // Also forward to the chat session so it resets conversation state + session pool
        const clearResolver = chatInputResolverRef.current
        if (clearResolver) {
          chatInputResolverRef.current = null
          clearResolver('/clear')
        }
        return
      }

      // ── Parse slash command args ──
      const isSlash = trimmed.startsWith('/')
      const args = normalizeSlashCommandArgs(parseShellArgs(trimmed))
      const firstArg = args[0]

      // ── /uninstall — client-only confirmation ──
      if (isSlash && firstArg === 'uninstall') {
        if (args.includes('--purge')) {
          addEntry({
            type: 'error',
            content:
              'kb uninstall removes the client only. To delete server data, exit and run: kb-server uninstall --purge',
          })
          return
        }
        addEntry({ type: 'chat-you', content: trimmed })
        addEntry({
          type: 'info',
          content:
            '⚠️  Uninstall the kb **client** only? kb-server and ~/.kb data (indexes, config, logs) will be kept. [y/N]',
        })
        setPendingConfirm({
          question: 'Uninstall kb client?',
          onConfirm: async () => {
            const lines: string[] = []
            const uninstallOut = {
              log: (msg: string) => {
                lines.push(msg)
              },
              error: (msg: string) => {
                lines.push(msg)
              },
              write: (chunk: string) => {
                lines.push(chunk)
              },
            }
            await performClientUninstall(uninstallOut)
            const output = lines.filter(l => l.trim()).join('\n')
            if (output) addEntry({ type: 'result', content: output })
            addEntry({
              type: 'result',
              content:
                'Done. kb client uninstalled. To remove kb-server and data: kb-server uninstall [--purge]',
            })
            exit()
          },
        })
        return
      }

      // ── Output-only slash commands (don't touch chatInputResolverRef) ──
      if (isSlash && firstArg && isOutputOnlyCommand(firstArg)) {
        addEntry({ type: 'chat-you', content: trimmed })

        // base delete — refused: deleting a base is an operator action on the server.
        if (firstArg === 'base' && args[1] === 'delete') {
          addEntry({
            type: 'error',
            content:
              'Deleting a base is an operator action on the server, not a client command. ' +
              'Run `kb-server base delete --base <base>` on the server host (or `kb-server uninstall --purge` ' +
              'to remove all server data). In the client you can only switch bases: /base use <base>.',
          })
          return
        }

        if (isRunning) return
        setIsRunning(true)
        const resultId = addEntry({ type: 'result', content: '', loading: true })

        try {
          let streamedLines = ''
          let commandError: string | null = null
          const output = await runCommandForTui(args, config, line => {
            streamedLines = streamedLines ? `${streamedLines}\n${line}` : line
            updateEntry(resultId, { content: streamedLines, loading: true })
          }, chatSessionIdRef.current, message => { commandError = message })

          if (firstArg === 'base') refreshBase()

          // A thrown command failure (e.g. unauthorized / connection refused) must render red,
          // not as a plain result. Errors shown to the user are always styled as errors.
          if (commandError) {
            updateEntry(resultId, { type: 'error', content: output || commandError, loading: false })
            return
          }

          const { segments, emptyPrimaryContent } = partitionShellOutputForTui(output)

          // Finalize the primary result entry BEFORE adding any meta entries.
          // Ink's <Static> commits entries to scrollback as soon as they become non-loading.
          // If meta entries (which have no loading flag) are added first, Static renders them
          // before the answer entry is finalized, causing the answer to be dropped or to
          // appear after the meta lines in the wrong order (same bug as the chat path).
          const firstBodyIdx = segments.findIndex(s => s.kind === 'body')
          const primaryContent =
            firstBodyIdx >= 0
              ? (segments[firstBodyIdx] as { kind: 'body'; text: string }).text
              : emptyPrimaryContent
          updateEntry(resultId, { content: primaryContent, loading: false })

          for (let i = 0; i < segments.length; i++) {
            const seg = segments[i]
            if (seg.kind === 'meta') {
              addEntry({ type: 'chat-meta', content: seg.line })
            } else if (i !== firstBodyIdx) {
              addEntry({ type: 'result', content: (seg as { kind: 'body'; text: string }).text })
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          updateEntry(resultId, { type: 'error', content: message, loading: false })
        } finally {
          setIsRunning(false)
        }
        return
      }

      // ── Everything else → chat session (LLM queries) ──
      addEntry({ type: 'chat-you', content: trimmed })
      if (shouldStartChatPending({ isSlash, readKind: chatReadKindRef.current })) {
        startChatPending()
      }
      const resolver = chatInputResolverRef.current
      if (resolver) {
        chatInputResolverRef.current = null
        chatReadKindRef.current = 'chat'
        resolver(trimmed)
      }
    },
    [
      isRunning,
      pendingConfirm,
      config,
      addEntry,
      updateEntry,
      startChatPending,
      refreshBase,
      exit,
    ]
  )

  const slashSuggestions = useMemo(() => {
    if (inlineSuggestions.length > 0 && !inputValue.startsWith('/')) {
      const lower = inputValue.toLowerCase()
      return inlineSuggestions
        .filter(s => s.toLowerCase().startsWith(lower))
        .map(s => ({ command: s, description: 'KB base' }))
    }
    return getSlashCommandSuggestions(inputValue, mode, slashContext)
  }, [inputValue, slashContext, inlineSuggestions])

  useEffect(() => {
    setSelectedSuggestionIndex(current => {
      if (slashSuggestions.length === 0) return 0
      if (current >= slashSuggestions.length) return 0
      return current
    })
  }, [slashSuggestions])

  useInput(
    (_input, key) => {
      if (slashSuggestions.length === 0) return

      if (key.downArrow) {
        setSelectedSuggestionIndex(current => clampSuggestionIndex(current + 1, slashSuggestions))
        return
      }

      if (key.upArrow) {
        setSelectedSuggestionIndex(current => clampSuggestionIndex(current - 1, slashSuggestions))
        return
      }

      if (key.tab) {
        const suggestion = slashSuggestions[selectedSuggestionIndex] ?? slashSuggestions[0]
        if (!suggestion) return
        setInputValue(applySelectedSuggestion(suggestion, inputValue))
      }
    },
    { isActive: slashSuggestions.length > 0 }
  )

  const handleInputChange = useCallback((nextValue: string) => {
    setInputValue(sanitizeSlashInput(nextValue))
  }, [])

  return (
    <Box flexDirection="column">
      <StatusBar
        serverHost={serverHost}
        baseName={baseName}
        baseIsServerDefault={baseIsServerDefault}
      />
      <HistoryPane entries={history} />
      <InputBar
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        mode={mode}
        isRunning={isRunning}
        chatPlaceholder={chatInputHint}
      />
      <SuggestionsBar
        suggestions={slashSuggestions}
        mode={mode}
        selectedIndex={selectedSuggestionIndex}
      />
    </Box>
  )
}
