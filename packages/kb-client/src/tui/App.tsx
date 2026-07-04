import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Box, useApp, useInput } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteBase,
  formatDeleteBaseResult,
  resolveEffectiveBaseDir,
} from '@kb/core/storage/base-selection.js'
import type { ChatIO, ChatReadOptions } from '../cli/chat-cli.js'
import { runChatSession } from '../cli/chat-cli.js'
import { performUninstall } from '../cli/uninstall-cli.js'
import {
  CLI_ERROR_NO_KB_BASE,
  autoInitAnnouncement,
  formatPrerequisiteError,
  initCancelledNotice,
  scanCancelledNotice,
  shouldAutoInit,
  uninitializedBaseNotice,
} from '@kb/core/config/cli-prerequisites.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import {
  createLLMProviderFromConfig,
} from '@kb/core/config/kb-config.js'
import { isInitCancelledError, parseInitCommand, runKbInit } from '@kb/core/ops/init-cli.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import { createKBToolsRegistry } from '@kb/core/tools/kb-tools-registry.js'
import { awaitRefreshThenStart } from './base-refresh.js'
import { classifyChatReadPromptKind, shouldStartChatPending } from './chat-read-kind.js'
import { classifyChatIOLine } from './chat-io-classify.js'
import { HistoryPane } from './components/HistoryPane.js'
import { InputBar } from './components/InputBar.js'
import { InitProgressBar } from './components/InitProgressBar.js'
import { StatusBar } from './components/StatusBar.js'
import { SuggestionsBar } from './components/SuggestionsBar.js'
import { partitionShellOutputForTui } from './partition-shell-output.js'
import { runCommandForTui, parseShellArgs } from './runner.js'
import { shouldUseRemoteServer } from '../cli/remote-commands.js'
import {
  applySelectedSuggestion,
  clampSuggestionIndex,
  getSlashCommandSuggestions,
  normalizeSlashCommandArgs,
  sanitizeSlashInput,
  type SlashInputContext,
} from './slash-commands.js'
import type { HistoryEntry, TuiMode } from './types.js'

function resolveApplyArgs(args: string[]): string[] | null {
  if (args.includes('--apply')) return null
  const first = args[0]
  if (first === 'publish') return [...args, '--apply']
  if (first === 'invalidate') return [...args, '--apply']
  if (first === 'scan') return [...args, '--apply']
  return null
}

/** Commands handled inline as transcript-only output; interactive flows stay out of this path. */
function isOutputOnlyCommand(first: string, args: string[]): boolean {
  if (first === 'init' || first === 'scan') return false
  if (first === 'docs' && args[1] === 'generate') return false
  const known = new Set([
    'query', 'submit', 'invalidate',
    'facts', 'graph', 'docs',
    'base', 'config', 'logs', 'skills', 'publish', 'sync',
  ])
  return known.has(first)
}

interface Props {
  config: KbConfig
  startupNotices?: string[]
}

export function App({ config, startupNotices = [] }: Props) {
  const { exit } = useApp()

  const mode: TuiMode = 'chat'
  const llmProvider = createLLMProviderFromConfig(config)
  const providerLabel = llmProvider ? `${llmProvider.name} ${llmProvider.model}` : ''
  const [history, setHistory] = useState<HistoryEntry[]>([
    { id: 'welcome', type: 'banner', content: providerLabel },
  ])
  const [inputValue, setInputValue] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [baseName, setBaseName] = useState('…')
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)
  const [baseResolved, setBaseResolved] = useState(false)

  const [pendingConfirm, setPendingConfirm] = useState<{
    question: string
    onConfirm: () => Promise<void>
  } | null>(null)
  const [chatInputHint, setChatInputHint] = useState('')
  const [slashContext, setSlashContext] = useState<SlashInputContext>('idle')
  const [inlineSuggestions, setInlineSuggestions] = useState<string[]>([])

  const [progressLine, setProgressLine] = useState<string | null>(null)
  const [initActive, setInitActive] = useState(false)

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

  const refreshBase = useCallback(() => {
    return resolveEffectiveBaseDir()
      .then(({ baseDir, baseName: n }) => {
        storageDirRef.current = baseDir
        setBaseName(n)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    resolveEffectiveBaseDir()
      .then(({ baseDir, baseName: effectiveBaseName }) => {
        storageDirRef.current = baseDir
        setBaseName(effectiveBaseName)
        setBaseResolved(true)
      })
      .catch(() => {
        storageDirRef.current = ''
        setBaseName('')
        setBaseResolved(true)
      })
  }, [])

  const startChatSession = useCallback(
    (opts: { verbose?: boolean } = {}) => {
      const verbose = opts.verbose === true
      // Remote mode: base, LLM provider, and retrieval all live server-side, so a thin client
      // needs neither a local base nor a local API key. Only local mode requires them.
      const remote = shouldUseRemoteServer()
      if (!remote && !storageDirRef.current) {
        addEntry({
          type: 'error',
          content: formatPrerequisiteError(CLI_ERROR_NO_KB_BASE),
        })
        return
      }
      const llmProvider = remote ? undefined : createLLMProviderFromConfig(config)
      if (!remote && !llmProvider) {
        // Startup notice already showed the key setup instructions; don't repeat.
        return
      }

      const storageDir = storageDirRef.current
      const toolExecutor =
        !remote && llmProvider
          ? createKBToolsRegistry(storageDir, config, { taskProvider: llmProvider })
          : undefined

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
          if (line) finalizeChatResponse()
          setProgressLine(line?.trimEnd() || null)
        },
      }

      runChatSession(
        {
          llmProvider,
          toolExecutor,
          mode: 'tui',
          kbStorageDir: storageDir,
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

  const handleInitFlowCancel = useCallback(
    async (flow: 'init' | 'scan') => {
      try {
        const { baseName } = await resolveEffectiveBaseDir()
        addEntry({
          type: 'info',
          content: flow === 'init' ? initCancelledNotice(baseName) : scanCancelledNotice(baseName),
        })
      } catch {
        addEntry({
          type: 'info',
          content: flow === 'init' ? initCancelledNotice() : scanCancelledNotice(),
        })
      }
      if (!chatSessionIdRef.current) {
        startChatSession()
      }
    },
    [addEntry, startChatSession]
  )

  const runInitFlow = useCallback(async (extraArgs: string[] = []) => {
    stopChatPending()
    finalizeChatResponse()
    setIsRunning(true)
    setInitActive(true)
    setProgressLine(null)
    try {
      if (shouldUseRemoteServer()) {
        const output = await runCommandForTui(
          ['init', ...extraArgs],
          config,
          line => setProgressLine(line.trimEnd()),
          chatSessionIdRef.current,
        )
        setProgressLine(null)
        if (output) addEntry({ type: 'result', content: output })
        await awaitRefreshThenStart(refreshBase, startChatSession)
        return
      }
      const parsed = parseInitCommand(extraArgs)
      const result = await runKbInit({
        ...parsed,
        questionIO: {
          write: (msg: string) => {
            const text = msg.trimEnd()
            if (text) addEntry({ type: 'result', content: text })
          },
          askQuestion: async (question, opts) => {
            setProgressLine(question.trimEnd())
            setSlashContext(opts?.slashContext ?? 'idle')
            setInlineSuggestions(opts?.suggestions ?? [])
            return new Promise(resolve => {
              chatInputResolverRef.current = value => {
                chatInputResolverRef.current = null
                setSlashContext('idle')
                setInlineSuggestions([])
                resolve(value ?? '')
              }
            })
          },
        },
        progressSink: (line: string) => setProgressLine(line.trimEnd()),
      })
      setProgressLine(null)
      const docCount = result.writtenDocIds?.length ?? 0
      addEntry({
        type: 'result',
        content: `✅ Init complete — ${docCount} doc${docCount === 1 ? '' : 's'} written to "${result.base}"`,
      })
      await awaitRefreshThenStart(refreshBase, startChatSession)
    } catch (err) {
      setProgressLine(null)
      if (isInitCancelledError(err)) {
        await handleInitFlowCancel('init')
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      addEntry({ type: 'error', content: message })
    } finally {
      setInitActive(false)
      setIsRunning(false)
    }
  }, [addEntry, config, refreshBase, startChatSession, handleInitFlowCancel, stopChatPending, finalizeChatResponse])

  // Start chat session once after base dir resolves; auto-init when .kb file points at an uninitialised base
  useEffect(() => {
    if (!baseResolved || chatStartedRef.current) return
    chatStartedRef.current = true
    resolveEffectiveBaseDir()
      .then(({ baseDir, baseName: effectiveBaseName, source }) => {
        const hasIndex = existsSync(path.join(baseDir, '.kb-index.sqlite'))
        if (shouldAutoInit(source, hasIndex)) {
          addEntry({ type: 'info', content: autoInitAnnouncement(effectiveBaseName) })
          runInitFlow(['--base', effectiveBaseName])
        } else if (!hasIndex) {
          addEntry({ type: 'info', content: uninitializedBaseNotice(effectiveBaseName) })
          startChatSession()
        } else {
          startChatSession()
        }
      })
      .catch(() => startChatSession())
  }, [baseResolved, startChatSession, runInitFlow, addEntry])

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
        setHistory([{ id: 'welcome', type: 'banner', content: '' }])
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

      // ── /uninstall — two-step confirmation ──
      if (isSlash && firstArg === 'uninstall') {
        addEntry({ type: 'chat-you', content: trimmed })
        const purge = args.includes('--purge')
        const kbHome = process.env.KB_INSTALL_ROOT ?? path.join(os.homedir(), '.kb')
        addEntry({
          type: 'info',
          content: purge
            ? `⚠️  Uninstall KB and permanently delete all user data at ${kbHome}? This cannot be undone. [y/N]`
            : `⚠️  Remove the KB binary, Python environment, and runtime? Knowledge bases at ${kbHome} will be kept (you can delete them after). [y/N]`,
        })
        setPendingConfirm({
          question: purge ? 'Uninstall KB and delete all data?' : 'Uninstall KB?',
          onConfirm: async () => {
            const lines: string[] = []
            const uninstallOut = {
              log: (msg: string) => { lines.push(msg) },
              error: (msg: string) => { lines.push(msg) },
              write: (chunk: string) => { lines.push(chunk) },
            }
            await performUninstall({ yes: true, purge }, uninstallOut)
            const output = lines.filter(l => l.trim()).join('\n')
            if (output) addEntry({ type: 'result', content: output })

            if (!purge) {
              addEntry({
                type: 'info',
                content: `Delete all KB user data at ${kbHome}? (knowledge bases, config, logs) [y/N]`,
              })
              setPendingConfirm({
                question: `Delete ${kbHome}?`,
                onConfirm: async () => {
                  await rm(kbHome, { recursive: true, force: true })
                  addEntry({ type: 'result', content: `Removed: ${kbHome}\n\nDone. KB has been uninstalled.` })
                  exit()
                },
              })
            } else {
              addEntry({ type: 'result', content: 'Done. KB has been uninstalled.' })
              exit()
            }
          },
        })
        return
      }

      // ── Output-only slash commands (don't touch chatInputResolverRef) ──
      if (isSlash && firstArg && isOutputOnlyCommand(firstArg, args)) {
        addEntry({ type: 'chat-you', content: trimmed })

        // base delete — confirmation prompt
        if (
          firstArg === 'base' &&
          args[1] === 'delete' &&
          !args.includes('--force') &&
          !args.includes('-f')
        ) {
          const base = args.slice(2).find(t => !t.startsWith('--'))
          if (base) {
            addEntry({
              type: 'info',
              content: `Delete base "${base}" and all its data? This cannot be undone. [y/N]`,
            })
            setPendingConfirm({
              question: `Delete base "${base}"?`,
              onConfirm: async () => {
                const result = await deleteBase(base)
                const msg = formatDeleteBaseResult(base, result, 'tui')
                addEntry({ type: 'result', content: msg })
                refreshBase()
              },
            })
            return
          }
        }

        // docs delete — confirmation prompt
        if (
          firstArg === 'docs' &&
          args[1] === 'delete' &&
          !args.includes('--force') &&
          !args.includes('-f')
        ) {
          const docId = args.slice(2).find(t => !t.startsWith('--'))
          if (docId) {
            addEntry({
              type: 'info',
              content: `Delete document "${docId}"? This cannot be undone. [y/N]`,
            })
            setPendingConfirm({
              question: `Delete document "${docId}"?`,
              onConfirm: async () => {
                const output = await runCommandForTui([...args, '--force'], config, undefined, chatSessionIdRef.current)
                if (output) addEntry({ type: 'result', content: output })
              },
            })
            return
          }
        }

        if (isRunning) return
        setIsRunning(true)
        const resultId = addEntry({ type: 'result', content: '', loading: true })

        try {
          let streamedLines = ''
          const output = await runCommandForTui(args, config, line => {
            streamedLines = streamedLines ? `${streamedLines}\n${line}` : line
            updateEntry(resultId, { content: streamedLines, loading: true })
          }, chatSessionIdRef.current)

          if (firstArg === 'base') refreshBase()

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

          const applyArgs = resolveApplyArgs(args)
          if (applyArgs) {
            addEntry({ type: 'info', content: 'Apply these changes? [y/N]' })
            setPendingConfirm({
              question: 'Apply?',
              onConfirm: async () => {
                const applyOutput = await runCommandForTui(applyArgs, config, undefined, chatSessionIdRef.current)
                if (applyOutput) addEntry({ type: 'result', content: applyOutput })
              },
            })
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          updateEntry(resultId, { type: 'error', content: message, loading: false })
        } finally {
          setIsRunning(false)
        }
        return
      }

      // ── /init and /scan with no active chat session — run directly ──
      if (isSlash && (firstArg === 'init' || firstArg === 'scan') && !chatInputResolverRef.current) {
        addEntry({ type: 'chat-you', content: trimmed })
        const extraArgs = args.slice(1)
        if (firstArg === 'init') {
          await runInitFlow(extraArgs)
        } else {
          setIsRunning(true)
          try {
            if (shouldUseRemoteServer()) {
              const output = await runCommandForTui(
                ['scan', ...extraArgs],
                config,
                line => {
                  const text = line.trimEnd()
                  if (text) addEntry({ type: 'result', content: text })
                },
                chatSessionIdRef.current,
              )
              setProgressLine(null)
              if (output) addEntry({ type: 'result', content: output.startsWith('✅') ? output : `✅ ${output}` })
              await awaitRefreshThenStart(refreshBase, startChatSession)
            } else {
              const summary = await runScanCommand(extraArgs, line => {
                const text = line.trimEnd()
                if (text) addEntry({ type: 'result', content: text })
              })
              setProgressLine(null)
              addEntry({ type: 'result', content: `✅ ${summary}` })
              await awaitRefreshThenStart(refreshBase, startChatSession)
            }
          } catch (err) {
            setProgressLine(null)
            const message = err instanceof Error ? err.message : String(err)
            addEntry({ type: 'error', content: message })
          } finally {
            setIsRunning(false)
          }
        }
        return
      }

      // ── Everything else → chat session (LLM queries, /init, /scan, /docs generate) ──
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
      startChatSession,
      runInitFlow,
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
      <StatusBar baseName={baseName} />
      {progressLine || initActive ? (
        <InitProgressBar line={progressLine} idle={initActive && !progressLine} />
      ) : null}
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
