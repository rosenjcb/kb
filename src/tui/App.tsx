import { Box, useApp } from 'ink'
import { useState, useEffect, useRef, useCallback } from 'react'
import type { KbConfig } from '../cli/kb-config.js'
import type { ChatIO } from '../cli/chat-cli.js'
import { createKBToolsRegistry } from '../tools/kb-tools-registry.js'
import { createLLMProviderFromConfig, resolveGraphEnabled } from '../cli/kb-config.js'
import { resolveEffectiveBaseDir } from '../cli/base-selection.js'
import { runChatSession } from '../cli/chat-cli.js'
import { DuckGraphWriter } from '../tools/duck-graph-writer.js'
import { runCommandForTui, parseShellArgs, printCliHelp } from './runner.js'
import { StatusBar } from './components/StatusBar.js'
import { HistoryPane } from './components/HistoryPane.js'
import { InputBar } from './components/InputBar.js'
import type { HistoryEntry, TuiMode } from './types.js'

interface Props {
  config: KbConfig
}

export function App({ config }: Props) {
  const { exit } = useApp()

  const [mode, setMode] = useState<TuiMode>('shell')
  const [history, setHistory] = useState<HistoryEntry[]>([
    { id: 'welcome', type: 'info', content: '  KB Agent — type a command or /help' },
  ])
  const [inputValue, setInputValue] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [baseName, setBaseName] = useState('…')

  const chatInputResolverRef = useRef<((v: string | null) => void) | null>(null)
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
        addEntry({ type: 'chat-assistant', content: line })
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

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return
      setInputValue('')

      // ── Chat mode: relay input to the running session ──
      if (mode === 'chat') {
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

      const args = parseShellArgs(trimmed)
      if (args.length === 0) return

      const firstArg = args[0]

      // Built-in TUI commands
      if (firstArg === '/exit' || firstArg === 'exit' || firstArg === 'quit') {
        exit()
        return
      }

      if (firstArg === '/clear' || firstArg === 'clear') {
        setHistory([])
        return
      }

      addEntry({ type: 'command', content: `kb> ${trimmed}` })

      if (firstArg === '/help' || firstArg === 'help' || firstArg === '--help') {
        addEntry({ type: 'info', content: printCliHelp() })
        return
      }

      if (firstArg === 'chat') {
        setMode('chat')
        addEntry({ type: 'info', content: 'Chat mode — type /exit to return to shell.' })
        startChatSession()
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
    [mode, isRunning, config, addEntry, updateEntry, startChatSession, exit],
  )

  return (
    <Box flexDirection="column">
      <StatusBar baseName={baseName} mode={mode} />
      <HistoryPane entries={history} />
      <InputBar
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        mode={mode}
        isRunning={isRunning}
      />
    </Box>
  )
}
