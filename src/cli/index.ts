#!/usr/bin/env node

/**
 * KB Agent Harness CLI
 * Quick demo runner
 */

import fs from 'fs'
import dayjs from 'dayjs'
import { createProvider } from '../core/llm-provider'
import { agentLoop } from '../core/agent-loop'
import { createKBToolsRegistry } from '../tools/kb-tools-registry'
import {
  enrichReadDocumentsAnswerWithLLM,
  executeIntentCommand,
  formatIntentResult,
  isIntentCommand,
  parseIntentCommand,
  printIntentHelp,
} from './intent-cli'
import { assertConsumerSafeCommand } from '../intents/policy'
import {
  formatDefaultCommandHelp,
  formatUseCommandHelp,
  readBaseConfig,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  writeDefaultBase,
  writeSessionBase,
} from './base-selection'

function printCliHelp(): string {
  return [
    'KB Agent Harness',
    '',
    'Usage:',
    '  kb <query>',
    '  kb <sessionFile.md> <query>',
    '  kb <intent-command> [options]',
    '',
    printIntentHelp(),
    '',
    'Examples:',
    '  kb "What tools are available?"',
    '  kb query "document store plan" --limit 5 --output json',
    '  kb use dogfood',
    '  kb use --show',
    '  kb default dogfood',
    '  kb default --show',
    '  kb submit "Fact text" --target session-log-2026-04-12',
    '',
    'Flags:',
    '  -h, --help    Show this help message',
  ].join('\n')
}

function loadLocalEnvFiles() {
  const processWithEnvLoader = process as typeof process & {
    loadEnvFile?: (path?: string) => void
  }

  if (!processWithEnvLoader.loadEnvFile) {
    return
  }

  if (fs.existsSync('.env.local')) {
    processWithEnvLoader.loadEnvFile('.env.local')
  }

  if (fs.existsSync('.env')) {
    processWithEnvLoader.loadEnvFile('.env')
  }
}

function resolveProviderFromEnv():
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama' {
  const raw = (process.env.LLM_PROVIDER || '').trim().toLowerCase()

  // Common typo/alias
  if (raw === 'openapi') return 'openai'

  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini' || raw === 'ollama') {
    return raw
  }

  // Auto-pick provider based on available credentials when not explicitly set.
  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.GEMINI_API_KEY) return 'gemini'

  // Fallback for local dev
  return 'ollama'
}

async function main() {
  loadLocalEnvFiles()
  console.log('🤖 KB Agent Harness\n')

  // Parse arguments: [sessionFile?] query...
  const args = process.argv.slice(2)
  const firstArg = args[0]

  if (args.length === 0 || firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    console.log(printCliHelp())
    return
  }

  if (firstArg === 'use') {
    const base = args[1]
    if (base === '--show' || !base) {
      const configured = await readBaseConfig()
      let effective: Awaited<ReturnType<typeof resolveEffectiveBaseDir>> | null = null
      try {
        effective = await resolveEffectiveBaseDir()
      } catch {
        // No active base configured yet.
      }

      console.log('KB base configuration')
      if (effective) {
        console.log(`Source: ${effective.source}`)
        console.log(`Base: ${effective.baseName}`)
        console.log(`Resolved path: ${effective.baseDir}`)
      } else {
        console.log('No active base configured.')
      }
      if (configured.defaultBase) {
        console.log(`Saved default: ${configured.defaultBase}`)
      }
      if (configured.sessionBase) {
        console.log(`Session base: ${configured.sessionBase}`)
      }
      return
    }

    await writeSessionBase(base)
    const resolved = resolveBaseToDir(base)
    console.log(formatUseCommandHelp(base, resolved))
    return
  }

  if (firstArg === 'default') {
    const base = args[1]
    if (base === '--show' || !base) {
      const configured = await readBaseConfig()
      if (!configured.defaultBase) {
        console.log('No default base configured. Use: kb default <base>')
        return
      }
      const resolved = resolveBaseToDir(configured.defaultBase)
      console.log(`Default base: ${configured.defaultBase}`)
      console.log(`Resolved path: ${resolved}`)
      console.log('Use `kb default <base>` to change it.')
      return
    }

    const saved = await writeDefaultBase(base)
    const resolved = resolveBaseToDir(saved.defaultBase ?? base)
    console.log(formatDefaultCommandHelp(saved.defaultBase ?? base, resolved))
    return
  }

  let sessionFile: string | null = null
  let sessionContent = ''
  let query = ''

  // Treat first arg as a session file when it looks like markdown and a query follows.
  if (firstArg.endsWith('.md') && args.length > 1) {
    sessionFile = firstArg
    if (fs.existsSync(sessionFile)) {
      sessionContent = fs.readFileSync(sessionFile, 'utf-8')
    }
    query = args.slice(1).join(' ')
  } else {
    // All args are the query
    query = args.join(' ')
  }

  if (!query) {
    query = 'Hello! What can you do?'
  }

  const provider = resolveProviderFromEnv()
  const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir

  let llmProvider: ReturnType<typeof createProvider> | undefined

  function tryCreateLlmProvider() {
    try {
      switch (provider) {
        case 'anthropic':
          return createProvider({
            provider: 'anthropic',
            apiKey: process.env.ANTHROPIC_API_KEY,
          })
        case 'openai':
          return createProvider({
            provider: 'openai',
            apiKey: process.env.OPENAI_API_KEY,
          })
        case 'gemini':
          return createProvider({
            provider: 'gemini',
            apiKey: process.env.GEMINI_API_KEY,
          })
        case 'ollama':
        default:
          return createProvider({
            provider: 'ollama',
            endpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11434',
          })
      }
    } catch {
      return undefined
    }
  }

  // Consumer-intent command mode (bypasses LLM loop, routes intents directly)
  if (isIntentCommand(firstArg)) {
    try {
      const parsed = parseIntentCommand(args)
      const toolExecutor = createKBToolsRegistry(kbStorageDir)
      const result = await executeIntentCommand(parsed, toolExecutor)
      llmProvider = tryCreateLlmProvider()
      const enriched = await enrichReadDocumentsAnswerWithLLM(parsed, result, llmProvider)
      console.log(formatIntentResult(enriched, parsed.output))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`❌ ${message}`)
      console.error('')
      console.error(printIntentHelp())
      process.exit(1)
    }
  }

  // Enforce consumer-safe boundary for direct internal tool command attempts.
  try {
    assertConsumerSafeCommand(firstArg)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`❌ ${message}`)
    process.exit(1)
  }

  console.log(`📝 Query: ${query}`)
  if (sessionFile) {
    console.log(`📁 Session: ${sessionFile}`)
  }
  console.log(`🔌 Provider: ${provider}\n`)
  console.log(`🗂️ KB Storage: ${kbStorageDir}\n`)

  // Create provider
  try {
    llmProvider = tryCreateLlmProvider()
  } catch (error) {
    console.error('❌ Provider setup failed:', error)
    process.exit(1)
  }

  if (!llmProvider) {
    console.error('❌ Provider setup failed: provider was not initialized')
    process.exit(1)
  }

  // Run agent loop
  try {
    console.log('⏳ Running agent...\n')
    let eventCount = 0
    let fullResponse = ''

    // If session file exists, prepend context to query
    let contextualQuery = query
    if (sessionFile && sessionContent) {
      contextualQuery = `Context from session:\n\`\`\`\n${sessionContent}\n\`\`\`\n\nNew query: ${query}`
    }

    // Create KB tools registry
    const toolExecutor = createKBToolsRegistry(kbStorageDir)

    for await (const event of agentLoop(contextualQuery, llmProvider, toolExecutor)) {
      eventCount++

      switch (event.type) {
        case 'text':
          console.log(`💬 ${event.content}`)
          fullResponse += event.content
          break
        case 'tool_start':
          console.log(`🔨 Tool: ${event.toolName} (${event.toolUseId})`)
          break
        case 'tool_result':
          console.log(
            `✅ Result: ${JSON.stringify(event.result).slice(0, 100)}...`
          )
          break
        case 'metadata':
          console.log(
            `📊 Usage: ${event.usage.inputTokens} in, ${event.usage.outputTokens} out`
          )
          break
        case 'done':
          console.log(`\n✨ Done: ${event.reason}`)
          break
        case 'error':
          console.error(`❌ Error: ${event.error.message}`)
          break
      }
    }

    console.log(`\n📈 Total events: ${eventCount}`)

    // If session file, append the result and query to it
    if (sessionFile && fullResponse) {
      const timestamp = dayjs().toISOString()
      const sessionUpdate = `\n## Query (${timestamp})\n${query}\n\n## Response\n${fullResponse}\n`
      fs.appendFileSync(sessionFile, sessionUpdate)
      console.log(`\n✅ Session updated: ${sessionFile}`)
    }
  } catch (error) {
    const err = error as { cause?: { code?: string } }
    if (provider === 'ollama' && err?.cause?.code === 'ECONNREFUSED') {
      console.error('❌ Could not connect to Ollama at http://localhost:11434')
      console.error('   Use OpenAI instead:')
      console.error('   export LLM_PROVIDER=openai')
      console.error('   export OPENAI_API_KEY=your_key')
      console.error('   pnpm run dev "hello"')
    } else {
      console.error('❌ Agent loop failed:', error)
    }
    process.exit(1)
  }
}

main().catch(console.error)
