#!/usr/bin/env node

/**
 * KB Agent Harness CLI
 * Quick demo runner
 */

import fs from 'fs'
import { createProvider } from '../core/llm-provider'
import { agentLoop } from '../core/agent-loop'
import { createKBToolsRegistry } from '../tools/kb-tools-registry'

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
  console.log('🤖 KB Agent Harness\n')

  // Parse arguments: [sessionFile?] query...
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: kb <query> or kb <sessionFile> <query>')
    process.exit(1)
  }

  let sessionFile: string | null = null
  let sessionContent = ''
  let query = ''

  // Check if first arg is a file path
  const firstArg = args[0]
  if (firstArg.endsWith('.md') && fs.existsSync(firstArg)) {
    // First arg is a session file
    sessionFile = firstArg
    sessionContent = fs.readFileSync(sessionFile, 'utf-8')
    query = args.slice(1).join(' ')
  } else {
    // All args are the query
    query = args.join(' ')
  }

  if (!query) {
    query = 'Hello! What can you do?'
  }

  const provider = resolveProviderFromEnv()

  console.log(`📝 Query: ${query}`)
  if (sessionFile) {
    console.log(`📁 Session: ${sessionFile}`)
  }
  console.log(`🔌 Provider: ${provider}\n`)

  // Create provider
  let llmProvider
  try {
    switch (provider) {
      case 'anthropic':
        llmProvider = createProvider({
          provider: 'anthropic',
          apiKey: process.env.ANTHROPIC_API_KEY,
        })
        break
      case 'openai':
        llmProvider = createProvider({
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY,
        })
        break
      case 'gemini':
        llmProvider = createProvider({
          provider: 'gemini',
          apiKey: process.env.GEMINI_API_KEY,
        })
        break
      case 'ollama':
      default:
        llmProvider = createProvider({
          provider: 'ollama',
          endpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11434',
        })
        break
    }
  } catch (error) {
    console.error('❌ Provider setup failed:', error)
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
    const toolExecutor = createKBToolsRegistry()

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
      const timestamp = new Date().toISOString()
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
