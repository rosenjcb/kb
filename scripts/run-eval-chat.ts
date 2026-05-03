import process from 'node:process'
import { ensureOperationalBaseDir } from '../src/cli/base-selection.js'
import { runChatSession } from '../src/cli/chat-cli.js'
import {
  createLLMProviderFromConfig,
  readKbConfig,
  resolveConversationalChatEnabled,
  resolveGraphEnabled,
} from '../src/cli/kb-config.js'
import { KbGraphWriter } from '../src/tools/kb-graph-writer.js'
import { createKBToolsRegistry } from '../src/tools/kb-tools-registry.js'

const QUESTIONS = [
  'What is this project for, and what are the main things kb can do?',
  'How does kb init work at a high level, including the major passes?',
  'Where do KB documents live, and how are active/default bases selected?',
  'How does retrieval work, including hybrid retrieval and graph involvement?',
  'What does kb chat do when retrieval is weak or incomplete?',
  'What commands should a contributor use during normal dogfood development in this repo?',
  'What special repo rules apply to KB documentation and persistence?',
  'How can someone inspect the graph and run telemetry/log comparisons?',
]

async function main(): Promise<void> {
  const base = process.argv[2]
  if (!base) {
    process.stderr.write('Usage: run-eval-chat.ts <base>\n')
    process.exit(1)
  }

  const results: string[] = []
  const config = await readKbConfig()
  const llmProvider = createLLMProviderFromConfig(config)
  if (!llmProvider) throw new Error('No LLM provider configured')

  const storageDir = await ensureOperationalBaseDir(base)
  const toolExecutor = createKBToolsRegistry(storageDir, config)
  const graphWriter = resolveGraphEnabled(config)
    ? new KbGraphWriter(KbGraphWriter.dbPathForBase(storageDir))
    : undefined

  const inputs = [...QUESTIONS, '/exit']
  let inputIdx = 0

  const io = {
    async read(): Promise<string | null> {
      return inputs[inputIdx++] ?? null
    },
    write(line: string): void {
      process.stderr.write(`  ${line}\n`)
      results.push(line)
    },
    error(line: string): void {
      process.stderr.write(`  ERROR: ${line}\n`)
      results.push(`ERROR: ${line}`)
    },
  }

  await runChatSession(
    {
      llmProvider,
      toolExecutor,
      graphWriter,
      conversationalRetrieval: resolveConversationalChatEnabled(config),
    },
    io
  )

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
}

main().catch(err => {
  process.stderr.write(`${String(err)}\n`)
  process.exit(1)
})
