import { Box, useApp, useInput } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteBase,
  formatDeleteBaseResult,
  resolveEffectiveBaseDir,
} from '../cli/base-selection.js'
import type { ChatIO } from '../cli/chat-cli.js'
import { runChatSession } from '../cli/chat-cli.js'
import {
  CLI_ERROR_NO_KB_BASE,
  CLI_ERROR_NO_LLM_PROVIDER,
  formatPrerequisiteError,
} from '../cli/cli-prerequisites.js'
import type { InitOptions, InitQuestionIO } from '../cli/init-cli.js'
import { parseInitCommand, parseScanCommand, runKbInit } from '../cli/init-cli.js'
import type { KbConfig } from '../cli/kb-config.js'
import {
  createLLMProviderFromConfig,
  resolveConversationalChatEnabled,
  resolveGraphEnabled,
} from '../cli/kb-config.js'
import { KbGraphWriter } from '../tools/kb-graph-writer.js'
import { createKBToolsRegistry } from '../tools/kb-tools-registry.js'
import { isOrchestrationMetaLine } from '../ui/orchestration-meta.js'
import { HistoryPane } from './components/HistoryPane.js'
import { InitStatusPanel } from './components/InitStatusPanel.js'
import { InputBar } from './components/InputBar.js'
import { StatusBar } from './components/StatusBar.js'
import { SuggestionsBar } from './components/SuggestionsBar.js'
import { ensureInitBaseArg, ensureScanBaseArg } from './init-args.js'
import type { InitStatusState } from './init-status.js'
import { parseInitOutput } from './init-status.js'
import { partitionShellOutputForTui } from './partition-shell-output.js'
import { parseShellArgs, printCliHelp, runCommandForTui } from './runner.js'
import {
  applySelectedSuggestion,
  clampSuggestionIndex,
  getSlashCommandSuggestions,
  normalizeSlashCommandArgs,
  sanitizeSlashInput,
} from './slash-commands.js'
import type { HistoryEntry, TuiMode } from './types.js'

/**
 * For commands that are preview-only without --apply, return the apply variant.
 * Returns null if the command already includes --apply or isn't a preview command.
 */
function resolveApplyArgs(args: string[]): string[] | null {
  if (args.includes('--apply')) return null
  const first = args[0]
  // publish notion|jekyll <...>
  if (first === 'publish') return [...args, '--apply']
  // invalidate "<fact>" [...]
  if (first === 'invalidate') return [...args, '--apply']
  // init --rescan (without --apply)
  if (first === 'init' && args.includes('--rescan')) return [...args, '--apply']
  // scan (without --apply)
  if (first === 'scan') return [...args, '--apply']
  return null
}

interface Props {
  config: KbConfig
  startupNotices?: string[]
}

export function App({ config, startupNotices = [] }: Props) {
  const { exit } = useApp()

  const [mode, setMode] = useState<TuiMode>('shell')
  const [history, setHistory] = useState<HistoryEntry[]>([
    { id: 'welcome', type: 'banner', content: '' },
  ])
  const [inputValue, setInputValue] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [baseName, setBaseName] = useState('…')
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)
  const [initStatus, setInitStatus] = useState<InitStatusState>({})

  const [pendingConfirm, setPendingConfirm] = useState<{
    question: string
    onConfirm: () => Promise<void>
  } | null>(null)
  /** When chat `read()` passes a non-idle prompt (e.g. docs wizard), show in history + input placeholder. */
  const [chatInputHint, setChatInputHint] = useState('')

  const chatInputResolverRef = useRef<((v: string | null) => void) | null>(null)
  const initInputResolverRef = useRef<((v: string) => void) | null>(null)
  const chatPendingEntryIdRef = useRef<string | null>(null)
  const storageDirRef = useRef<string>('')
  const entryCounterRef = useRef(0)

  // Stable helpers using only refs — safe to omit from dep arrays
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

  // Resolve base dir on mount (effective base: activeBase, else defaultBase)
  useEffect(() => {
    resolveEffectiveBaseDir()
      .then(({ baseDir, baseName: effectiveBaseName }) => {
        storageDirRef.current = baseDir
        setBaseName(effectiveBaseName)
      })
      .catch(() => {
        storageDirRef.current = ''
        setBaseName('')
      })
  }, [])

  const startChatSession = useCallback(
    (opts: { verbose?: boolean; debug?: boolean } = {}) => {
      const verbose = opts.verbose === true
      const debug = opts.debug === true
      if (!storageDirRef.current) {
        addEntry({
          type: 'error',
          content: formatPrerequisiteError(CLI_ERROR_NO_KB_BASE),
        })
        setMode('shell')
        return
      }
      const llmProvider = createLLMProviderFromConfig(config)
      if (!llmProvider) {
        addEntry({
          type: 'error',
          content: formatPrerequisiteError(CLI_ERROR_NO_LLM_PROVIDER),
        })
        setMode('shell')
        return
      }

      const storageDir = storageDirRef.current
      const toolExecutor = createKBToolsRegistry(storageDir, config, { taskProvider: llmProvider })
      const graphWriter = resolveGraphEnabled(config)
        ? new KbGraphWriter(KbGraphWriter.dbPathForBase(storageDir))
        : undefined

      setChatInputHint('')

      const chatIO: ChatIO = {
        async read(prompt: string): Promise<string | null> {
          const normalized = prompt.replace(/\r/g, '').trim()
          const firstLine =
            normalized
              .split('\n')
              .find(l => l.trim().length > 0)
              ?.trim() ?? ''
          const isIdleReadPrompt = /^you\s*>?\s*$/i.test(firstLine)
          if (normalized.length > 0 && !isIdleReadPrompt) {
            const oneLine = normalized.replace(/\s+/g, ' ').trim()
            const clipped = oneLine.length > 500 ? `${oneLine.slice(0, 497)}…` : oneLine
            addEntry({ type: 'info', content: clipped })
            const hint = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
            setChatInputHint(hint)
          }
          return new Promise<string | null>(resolve => {
            chatInputResolverRef.current = (value: string | null) => {
              chatInputResolverRef.current = null
              setChatInputHint('')
              resolve(value)
            }
          })
        },
        write(line: string) {
          stopChatPending()
          if (isOrchestrationMetaLine(line)) {
            addEntry({ type: 'chat-meta', content: line })
            return
          }

          const clean = line.startsWith('assistant> ') ? line.slice('assistant> '.length) : line
          if (!clean.trim()) return
          addEntry({ type: 'chat-assistant', content: clean })
        },
        error(line: string) {
          stopChatPending()
          addEntry({ type: 'error', content: line })
        },
      }

      runChatSession(
        {
          llmProvider,
          toolExecutor,
          mode: 'tui',
          graphWriter,
          kbStorageDir: storageDir,
          kbConfig: config,
          conversationalRetrieval: resolveConversationalChatEnabled(config),
          verbose,
          debug,
        },
        chatIO
      )
        .then(() => {
          stopChatPending()
          setChatInputHint('')
          setMode('shell')
        })
        .catch(err => {
          stopChatPending()
          setChatInputHint('')
          const message = err instanceof Error ? err.message : String(err)
          addEntry({ type: 'error', content: `Chat error: ${message}` })
          setMode('shell')
        })
    },
    [config, addEntry, stopChatPending]
  )

  const startInitSession = useCallback(
    (command: 'init' | 'scan', extraArgs: string[]) => {
      const isScan = command === 'scan'
      setInitStatus({
        message: isScan
          ? 'Scanning repo into KB — press Enter to skip any question.'
          : 'Initializing KB — press Enter to skip any question.',
        progressLine: isScan ? '[scan] starting…' : '[init] starting…',
        actionLine: isScan
          ? '[scan:action] waiting for first step…'
          : '[init:action] waiting for first step…',
      })

      const questionIO: InitQuestionIO = {
        write(message: string) {
          const parsed = parseInitOutput(message)
          for (const line of parsed.historyLines) {
            addEntry({ type: 'info', content: line })
          }
          if (parsed.progressLine) {
            setInitStatus(current => ({ ...current, progressLine: parsed.progressLine }))
          }
          if (parsed.actionLine) {
            setInitStatus(current => ({ ...current, actionLine: parsed.actionLine }))
          }
        },
        async askQuestion(question: string): Promise<string> {
          addEntry({ type: 'info', content: question.trim() })
          return new Promise<string>(resolve => {
            initInputResolverRef.current = resolve
          })
        },
      }

      let parsed: InitOptions
      try {
        if (isScan) {
          parsed = parseScanCommand(ensureScanBaseArg(extraArgs, baseName))
        } else {
          parsed = parseInitCommand(ensureInitBaseArg(extraArgs, baseName))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        addEntry({ type: 'error', content: `❌ ${message}` })
        setMode('shell')
        return
      }

      runKbInit({
        ...parsed,
        questionIO,
        progressSink(line) {
          const parsedProgress = parseInitOutput(line)
          if (parsedProgress.progressLine) {
            setInitStatus(current => ({ ...current, progressLine: parsedProgress.progressLine }))
          }
          if (parsedProgress.actionLine) {
            setInitStatus(current => ({ ...current, actionLine: parsedProgress.actionLine }))
          }
        },
      })
        .then(result => {
          const docCount = result.writtenDocIds?.length ?? 0
          setInitStatus({})
          addEntry({
            type: 'result',
            content: isScan
              ? `✅ Scan complete — ${docCount} doc${docCount === 1 ? '' : 's'} refreshed in "${result.base}"`
              : `✅ Init complete — ${docCount} doc${docCount === 1 ? '' : 's'} written to "${result.base}"`,
          })
          resolveEffectiveBaseDir()
            .then(({ baseDir, baseName: effectiveBaseName }) => {
              storageDirRef.current = baseDir
              setBaseName(effectiveBaseName)
            })
            .catch(() => {
              storageDirRef.current = ''
              setBaseName(result.base)
            })
          setMode('shell')
        })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err)
          setInitStatus({})
          addEntry({ type: 'error', content: `${isScan ? 'Scan' : 'Init'} error: ${message}` })
          setMode('shell')
        })
    },
    [addEntry, baseName]
  )

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return
      setInputValue('')

      // ── Init mode: relay answers to the running init session ──
      if (mode === 'init') {
        addEntry({ type: 'chat-you', content: trimmed })
        const resolver = initInputResolverRef.current
        if (resolver) {
          initInputResolverRef.current = null
          resolver(trimmed)
        }
        return
      }

      // ── Chat mode: relay input to the running session ──
      if (mode === 'chat') {
        if (trimmed === '/help') {
          addEntry({ type: 'info', content: 'Chat mode commands: /help, /clear, /exit' })
          return
        }
        if (trimmed === '/clear') {
          setHistory([{ id: 'welcome', type: 'banner', content: '' }])
          return
        }
        addEntry({ type: 'chat-you', content: trimmed })
        if (trimmed !== '/exit') {
          startChatPending()
        }
        const resolver = chatInputResolverRef.current
        if (resolver) {
          chatInputResolverRef.current = null
          resolver(trimmed === '/exit' ? null : trimmed)
        }
        if (trimmed === '/exit') {
          stopChatPending()
          setMode('shell')
        }
        return
      }

      // ── Pending confirmation ──
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

      // ── Shell mode ──
      if (isRunning) return

      const args = normalizeSlashCommandArgs(parseShellArgs(trimmed))
      if (args.length === 0) return

      const firstArg = args[0]

      // Built-in TUI commands
      if (firstArg === 'exit' || firstArg === 'quit') {
        exit()
        return
      }

      if (firstArg === 'clear') {
        setHistory([{ id: 'welcome', type: 'banner', content: '' }])
        return
      }

      addEntry({ type: 'command', content: `kb> ${trimmed}` })

      if (firstArg === 'help' || firstArg === '--help') {
        addEntry({ type: 'info', content: printCliHelp('tui') })
        return
      }

      if (firstArg === 'chat') {
        setMode('chat')
        const chatVerbose = args.includes('--verbose')
        const chatDebug = args.includes('--debug')
        let chatBanner = 'Chat mode — type /exit to return to shell.'
        if (chatVerbose && chatDebug) {
          chatBanner = 'Chat mode (verbose + debug orchestration) — type /exit to return to shell.'
        } else if (chatVerbose) {
          chatBanner = 'Chat mode (verbose orchestration) — type /exit to return to shell.'
        } else if (chatDebug) {
          chatBanner = 'Chat mode (debug source lines) — type /exit to return to shell.'
        }
        addEntry({ type: 'info', content: chatBanner })
        startChatSession({ verbose: chatVerbose, debug: chatDebug })
        return
      }

      if (firstArg === 'init') {
        setMode('init')
        startInitSession('init', args.slice(1))
        return
      }

      if (firstArg === 'scan') {
        setMode('init')
        startInitSession('scan', args.slice(1))
        return
      }

      // Intercept `base delete <name>` without --force: show confirmation prompt
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
              // Refresh base name if we deleted the active base
              resolveEffectiveBaseDir()
                .then(({ baseDir, baseName: n }) => {
                  storageDirRef.current = baseDir
                  setBaseName(n)
                })
                .catch(() => {
                  storageDirRef.current = ''
                  setBaseName('')
                })
            },
          })
          return
        }
      }

      // Intercept `docs delete <id>` without --force: show confirmation prompt
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
              const forceArgs = [...args, '--force']
              const output = await runCommandForTui(forceArgs, config)
              if (output) addEntry({ type: 'result', content: output })
            },
          })
          return
        }
      }

      // Dispatch to existing CLI logic
      setIsRunning(true)
      const resultId = addEntry({ type: 'result', content: '', loading: true })

      try {
        const output = await runCommandForTui(args, config)

        // Refresh base name after base use / use / default commands
        if (firstArg === 'base' || firstArg === 'use' || firstArg === 'default') {
          resolveEffectiveBaseDir()
            .then(({ baseDir, baseName: effectiveBaseName }) => {
              storageDirRef.current = baseDir
              setBaseName(effectiveBaseName)
            })
            .catch(() => {
              storageDirRef.current = ''
              setBaseName('')
            })
        }

        const { segments, emptyPrimaryContent } = partitionShellOutputForTui(output)
        let filledPrimary = false
        for (const seg of segments) {
          if (seg.kind === 'meta') {
            addEntry({ type: 'chat-meta', content: seg.line })
          } else if (!filledPrimary) {
            updateEntry(resultId, { content: seg.text, loading: false })
            filledPrimary = true
          } else {
            addEntry({ type: 'result', content: seg.text })
          }
        }
        if (!filledPrimary) {
          updateEntry(resultId, { content: emptyPrimaryContent, loading: false })
        }

        // For preview-by-default commands, offer to apply after showing the plan
        const applyArgs = resolveApplyArgs(args)
        if (applyArgs) {
          addEntry({ type: 'info', content: 'Apply these changes? [y/N]' })
          setPendingConfirm({
            question: 'Apply?',
            onConfirm: async () => {
              const applyOutput = await runCommandForTui(applyArgs, config)
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
    },
    [
      mode,
      isRunning,
      pendingConfirm,
      config,
      addEntry,
      updateEntry,
      startChatSession,
      startInitSession,
      startChatPending,
      stopChatPending,
      exit,
    ]
  )

  const slashSuggestions = useMemo(
    () => getSlashCommandSuggestions(inputValue, mode),
    [inputValue, mode]
  )

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
        setInputValue(applySelectedSuggestion(suggestion))
      }
    },
    { isActive: slashSuggestions.length > 0 }
  )

  const handleInputChange = useCallback((nextValue: string) => {
    setInputValue(sanitizeSlashInput(nextValue))
  }, [])

  return (
    <Box flexDirection="column">
      <StatusBar baseName={baseName} mode={mode} />
      <HistoryPane entries={history} />
      <InputBar
        value={inputValue}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        mode={mode}
        isRunning={isRunning}
        chatPlaceholder={mode === 'chat' ? chatInputHint : ''}
      />
      <InitStatusPanel status={initStatus} visible={mode === 'init'} />
      <SuggestionsBar
        suggestions={slashSuggestions}
        mode={mode}
        selectedIndex={selectedSuggestionIndex}
      />
    </Box>
  )
}
