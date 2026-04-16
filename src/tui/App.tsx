import { Box, useApp, useInput } from 'ink'
import { useState, useEffect, useRef, useCallback } from 'react'
import type { KbConfig } from '../cli/kb-config.js'
import type { ChatIO } from '../cli/chat-cli.js'
import type { InitQuestionIO } from '../cli/init-cli.js'
import { createKBToolsRegistry } from '../tools/kb-tools-registry.js'
import { createLLMProviderFromConfig, resolveGraphEnabled } from '../cli/kb-config.js'
import { resolveEffectiveBaseDir } from '../cli/base-selection.js'
import { runChatSession } from '../cli/chat-cli.js'
import { parseInitCommand, runKbInit } from '../cli/init-cli.js'
import { DuckGraphWriter } from '../tools/duck-graph-writer.js'
import { runCommandForTui, parseShellArgs, printCliHelp } from './runner.js'
import { StatusBar } from './components/StatusBar.js'
import { HistoryPane } from './components/HistoryPane.js'
import { InputBar } from './components/InputBar.js'
import { SuggestionsBar } from './components/SuggestionsBar.js'
import {
  applySelectedSuggestion,
  clampSuggestionIndex,
  getSlashCommandSuggestions,
  normalizeSlashCommandArgs,
  sanitizeSlashInput,
} from './slash-commands.js'
import type { HistoryEntry, TuiMode } from './types.js'

interface Props {
  config: KbConfig
}

export function App({ config }: Props) {
  const { exit } = useApp()

  const [mode, setMode] = useState<TuiMode>('shell')
  const [history, setHistory] = useState<HistoryEntry[]>([
    { id: 'welcome', type: 'banner', content: '' },
  ])
  const [inputValue, setInputValue] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [baseName, setBaseName] = useState('…')
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)

  const chatInputResolverRef = useRef<((v: string | null) => void) | null>(null)
  const initInputResolverRef = useRef<((v: string) => void) | null>(null)
  const storageDirRef = useRef<string>('')
  const entryCounterRef = useRef(0)

  // Stable helpers using only refs — safe to omit from dep arrays
  const addEntry = useCallback((entry: Omit<HistoryEntry, 'id'>): string => {
    const id = `e${++entryCounterRef.current}`
    setHistory(prev => [...prev, { ...entry, id }])
    return id
  }, [])

  const updateEntry = useCallback((id: string, patch: Partial<Omit<HistoryEntry, 'id'>>) => {
    setHistory(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)))
  }, [])

  // Resolve base dir on mount
  useEffect(() => {
    resolveEffectiveBaseDir()
      .then(({ baseDir, baseName: name }) => {
        storageDirRef.current = baseDir
        setBaseName(name)
      })
      .catch(() => {
        setBaseName('default')
      })
  }, [])

  const startChatSession = useCallback(() => {
    const llmProvider = createLLMProviderFromConfig(config)
    if (!llmProvider || !storageDirRef.current) {
      addEntry({
        type: 'error',
        content: '❌ Cannot start chat: no LLM provider or storage dir configured.',
      })
      setMode('shell')
      return
    }

    const storageDir = storageDirRef.current
    const toolExecutor = createKBToolsRegistry(storageDir, config)
    const graphWriter = resolveGraphEnabled(config)
      ? new DuckGraphWriter(DuckGraphWriter.dbPathForBase(storageDir))
      : undefined

    const chatIO: ChatIO = {
      async read(_prompt: string): Promise<string | null> {
        return new Promise<string | null>(resolve => {
          chatInputResolverRef.current = resolve
        })
      },
      write(line: string) {
        // Drop checkpoint noise
        if (line.startsWith('checkpoints>')) return

        // Route metadata lines to dim display
        if (line.startsWith('retrieval>') || line.startsWith('sources>')) {
          addEntry({ type: 'chat-meta', content: line })
          return
        }

        // Strip the "assistant> " prefix that chat-cli prepends
        const clean = line.startsWith('assistant> ') ? line.slice('assistant> '.length) : line
        if (!clean.trim()) return
        addEntry({ type: 'chat-assistant', content: clean })
      },
      error(line: string) {
        addEntry({ type: 'error', content: line })
      },
    }

    runChatSession({ llmProvider, toolExecutor, graphWriter }, chatIO)
      .then(() => {
        setMode('shell')
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        addEntry({ type: 'error', content: `Chat error: ${message}` })
        setMode('shell')
      })
  }, [config, addEntry])

  const startInitSession = useCallback((extraArgs: string[]) => {
    const progressEntryId = addEntry({ type: 'info', content: '[init] starting…' })
    const questionIO: InitQuestionIO = {
      write(message: string) {
        for (const line of message.split('\n')) {
          if (line.trim()) addEntry({ type: 'info', content: line })
        }
      },
      async askQuestion(question: string): Promise<string> {
        addEntry({ type: 'info', content: question.trim() })
        return new Promise<string>(resolve => {
          initInputResolverRef.current = resolve
        })
      },
    }

    let parsed
    try {
      parsed = parseInitCommand(extraArgs)
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
        updateEntry(progressEntryId, { content: line.trimEnd() })
      },
    })
      .then(result => {
        const docCount = result.writtenDocIds?.length ?? 0
        addEntry({
          type: 'result',
          content: `✅ Init complete — ${docCount} doc${docCount === 1 ? '' : 's'} written to "${result.base}"`,
        })
        setMode('shell')
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        addEntry({ type: 'error', content: `Init error: ${message}` })
        setMode('shell')
      })
  }, [addEntry, updateEntry])

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
        const resolver = chatInputResolverRef.current
        if (resolver) {
          chatInputResolverRef.current = null
          resolver(trimmed === '/exit' ? null : trimmed)
        }
        if (trimmed === '/exit') setMode('shell')
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
        addEntry({ type: 'info', content: printCliHelp() })
        return
      }

      if (firstArg === 'chat') {
        setMode('chat')
        addEntry({ type: 'info', content: 'Chat mode — type /exit to return to shell.' })
        startChatSession()
        return
      }

      if (firstArg === 'init') {
        setMode('init')
        addEntry({ type: 'info', content: 'Initializing KB — press Enter to skip any question.' })
        startInitSession(args.slice(1))
        return
      }

      // Dispatch to existing CLI logic
      setIsRunning(true)
      const resultId = addEntry({ type: 'result', content: '', loading: true })

      try {
        const output = await runCommandForTui(args, config)

        // Refresh base name after use/default commands
        if (firstArg === 'use' || firstArg === 'default') {
          resolveEffectiveBaseDir()
            .then(({ baseDir, baseName: newBase }) => {
              storageDirRef.current = baseDir
              setBaseName(newBase)
            })
            .catch(() => {})
        }

        updateEntry(resultId, { content: output, loading: false })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        updateEntry(resultId, { type: 'error', content: message, loading: false })
      } finally {
        setIsRunning(false)
      }
    },
    [mode, isRunning, config, addEntry, updateEntry, startChatSession, startInitSession, exit],
  )

  const slashSuggestions = getSlashCommandSuggestions(inputValue, mode)

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
    { isActive: slashSuggestions.length > 0 },
  )

  const handleInputChange = useCallback(
    (nextValue: string) => {
      setInputValue(sanitizeSlashInput(nextValue))
    },
    [],
  )

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
      />
      <SuggestionsBar
        suggestions={slashSuggestions}
        mode={mode}
        selectedIndex={selectedSuggestionIndex}
      />
    </Box>
  )
}
