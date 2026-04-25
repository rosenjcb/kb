#!/usr/bin/env tsx
/**
 * Smoke-test **`kb chat`** answer enrichment + clarify follow-up (no TTY required).
 *
 *   npx tsx scripts/chat-clarify-smoke.ts
 *
 * Uses your real `~/.kb/config.json`, active base, LLM, and graph — same stack as `kb chat`.
 */
import { resolveEffectiveBaseDir } from '../src/cli/base-selection.js'
import { type ChatIO, runChatSession } from '../src/cli/chat-cli.js'
import {
  applyConfigToEnv,
  createLLMProviderFromConfig,
  ensureDefaultConfig,
  resolveConversationalChatEnabled,
} from '../src/cli/kb-config.js'
import { DuckGraphWriter } from '../src/tools/duck-graph-writer.js'
import { createKBToolsRegistry } from '../src/tools/kb-tools-registry.js'

class QueueIO implements ChatIO {
  constructor(private readonly lines: string[]) {}

  async read(_prompt: string): Promise<string | null> {
    return this.lines.shift() ?? null
  }

  write(line: string): void {
    console.log(line)
  }

  error(line: string): void {
    console.error(line)
  }
}

async function main(): Promise<void> {
  const config = await ensureDefaultConfig()
  applyConfigToEnv(config)

  const llmProvider = createLLMProviderFromConfig(config)
  if (!llmProvider) {
    console.error('No LLM provider (set API keys / ollama and config.llm.provider).')
    process.exit(1)
  }

  const { baseDir } = await resolveEffectiveBaseDir()
  const toolExecutor = createKBToolsRegistry(baseDir, config, { taskProvider: llmProvider })
  const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(baseDir))

  const io = new QueueIO([
    'What is the purpose of life and the universe?',
    'Scoped: only this KB repo — how does hybrid retrieval work?',
    '/exit',
  ])

  console.log('--- chat-clarify-smoke (2 user turns + /exit) ---\n')

  await runChatSession(
    {
      llmProvider,
      toolExecutor,
      graphWriter,
      workspaceDir: baseDir,
      conversationalRetrieval: resolveConversationalChatEnabled(config),
    },
    io
  )

  await graphWriter.close().catch(() => {})
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
