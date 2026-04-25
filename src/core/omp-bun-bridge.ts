import { stdin as input, stdout as output } from 'node:process'
import type { OmpCodingAgentModule } from './omp-agent-types.js'

interface BridgeRequest {
  cwd: string
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  model: string
  apiKey?: string
  endpoint?: string
  systemPrompt?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
}

async function readStdin(): Promise<string> {
  let data = ''
  for await (const chunk of input) data += String(chunk)
  return data
}

function seedProviderEnv(req: BridgeRequest): void {
  if (req.provider === 'anthropic' && req.apiKey) process.env.ANTHROPIC_API_KEY = req.apiKey
  if (req.provider === 'openai' && req.apiKey) process.env.OPENAI_API_KEY = req.apiKey
  if (req.provider === 'gemini' && req.apiKey) process.env.GEMINI_API_KEY = req.apiKey
  if (req.provider === 'ollama' && req.endpoint) process.env.OLLAMA_ENDPOINT = req.endpoint
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      if (record.type === 'text' && typeof record.content === 'string') return record.content
      return ''
    })
    .join('')
    .trim()
}

function renderBridgePrompt(req: BridgeRequest): string {
  return req.messages
    .map(message => {
      const role = message.role === 'assistant' ? 'ASSISTANT' : 'USER'
      return `${role}:\n${message.content}`
    })
    .join('\n\n')
}

async function main(): Promise<void> {
  // biome-ignore lint/security/noGlobalEval: Bun entry must load OMP without static import (see omp-runtime.ts)
  // biome-ignore lint/style/noCommaOperator: indirect eval for dynamic import
  const omp = (await (0, eval)('import("@oh-my-pi/pi-coding-agent")')) as OmpCodingAgentModule
  const { ModelRegistry, SessionManager, Settings, createAgentSession, discoverAuthStorage } = omp

  const req = JSON.parse(await readStdin()) as BridgeRequest
  seedProviderEnv(req)

  await Settings.init({ cwd: req.cwd })
  const authStorage = await discoverAuthStorage()
  const modelRegistry = new ModelRegistry(authStorage)
  await modelRegistry.refresh()
  const model = modelRegistry.find(req.provider, req.model)

  const { session } = await createAgentSession({
    cwd: req.cwd,
    authStorage,
    modelRegistry,
    model,
    sessionManager: SessionManager.inMemory(req.cwd),
    enableMCP: false,
    enableLsp: false,
    systemPrompt: req.systemPrompt,
    toolNames: ['read', 'grep', 'find', 'edit', 'write', 'bash'],
  })

  let streamedText = ''
  const unsubscribe = session.subscribe((event: unknown) => {
    const e = event as {
      type?: string
      assistantMessageEvent?: { type?: string; delta?: string }
    }
    if (
      e.type === 'message_update' &&
      e.assistantMessageEvent?.type === 'text_delta' &&
      typeof e.assistantMessageEvent.delta === 'string'
    ) {
      streamedText += e.assistantMessageEvent.delta
    }
  })

  try {
    await session.prompt(renderBridgePrompt(req), { attribution: 'user' })
    await session.waitForIdle()
    const last = session.getLastAssistantMessage()
    let text = extractAssistantText(last?.content)
    if (!text.trim() && typeof session.getMessages === 'function') {
      const messages = session.getMessages() as Array<{ role?: string; content?: unknown }>
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role !== 'assistant') continue
        const candidate = extractAssistantText(messages[i]?.content)
        if (candidate.trim()) {
          text = candidate
          break
        }
      }
    }
    if (!text.trim() && streamedText.trim()) text = streamedText
    output.write(JSON.stringify({ text }))
  } finally {
    unsubscribe()
    await session.dispose()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
