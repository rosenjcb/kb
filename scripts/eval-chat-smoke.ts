/**
 * Chat improvement smoke test.
 *
 * Fires two scenarios against an existing kb base and checks for:
 *   1. Elaboration queries → multi-angle retrieval (decompose fires, retrieval > 0ms, 2+ query> lines)
 *   2. Direct lookups → single clean retrieval (no decompose overhead)
 *
 * Usage:
 *   npx tsx scripts/eval-chat-smoke.ts --base <base-name>
 */
import process from 'node:process'
import { ensureOperationalBaseDir } from '../src/cli/base-selection.js'
import { type ChatIO, runChatSession } from '../src/cli/chat-cli.js'
import { createLLMProviderFromConfig, readKbConfig } from '../src/cli/kb-config.js'
import { createKBToolsRegistry } from '../src/tools/kb-tools-registry.js'

interface TurnResult {
  prompt: string
  queryLines: string[]         // all "query> ..." lines (pre-step + main loop)
  retrievalMs: number
  factsMatched: number
  answer: string
  passed: boolean
  reason: string
}

class CapturingIO implements ChatIO {
  public lines: string[] = []
  constructor(private inputs: string[]) {}
  async read(): Promise<string | null> { return this.inputs.shift() ?? null }
  write(line: string): void { this.lines.push(line) }
  error(line: string): void { this.lines.push(line) }
}

function parseLines(lines: string[]): { queryLines: string[]; retrievalMs: number; factsMatched: number; answer: string } {
  const queryLines = lines.filter(l => l.startsWith('query> ')).map(l => l.replace('query> ', ''))
  const timingLine = lines.find(l => l.startsWith('timing> '))
  const retrievalMs = timingLine ? Number(timingLine.match(/retrieval=(\d+)ms/)?.[1] ?? 0) : 0
  const matchesLine = lines.find(l => l.startsWith('matches> '))
  const factsMatched = matchesLine ? Number(matchesLine.match(/matches> (\d+)/)?.[1] ?? 0) : 0
  const answerLine = lines.find(l => l.startsWith('assistant> '))
  const answer = answerLine ? answerLine.replace('assistant> ', '') : ''
  return { queryLines, retrievalMs, factsMatched, answer }
}

async function runScenario(
  prompt: string,
  base: string,
  expectDecompose: boolean,
  cwd: string,
  config: Awaited<ReturnType<typeof readKbConfig>>,
  llmProvider: NonNullable<ReturnType<typeof createLLMProviderFromConfig>>
): Promise<TurnResult> {
  const baseDir = await ensureOperationalBaseDir(base, cwd)
  const toolExecutor = createKBToolsRegistry(baseDir, config)

  const io = new CapturingIO([prompt, '/exit'])
  await runChatSession({ llmProvider, toolExecutor }, io)

  const { queryLines, retrievalMs, factsMatched, answer } = parseLines(io.lines)

  let passed: boolean
  let reason: string

  if (expectDecompose) {
    passed = queryLines.length >= 2 && retrievalMs > 0
    reason = passed
      ? `✓ ${queryLines.length} query calls, retrieval=${retrievalMs}ms, matches=${factsMatched}`
      : `✗ only ${queryLines.length} query call(s), retrieval=${retrievalMs}ms — expected multi-angle retrieval`
  } else {
    passed = retrievalMs > 0
    reason = passed
      ? `✓ 1 query call, retrieval=${retrievalMs}ms, matches=${factsMatched}`
      : `✗ retrieval=${retrievalMs}ms — expected at least one retrieval`
  }

  return { prompt, queryLines, retrievalMs, factsMatched, answer, passed, reason }
}

async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv.slice(2).flatMap((v, i, a) => (v.startsWith('--') ? [[v, a[i + 1]]] : []))
  )
  const base = args['--base'] ?? 'kb-2026-05-08-1742'
  const cwd = args['--cwd'] ?? process.cwd()

  const config = await readKbConfig()
  const llmProvider = createLLMProviderFromConfig(config)
  if (!llmProvider) throw new Error('No LLM provider configured. Check ~/.kb/config.json.')

  const scenarios: Array<{ prompt: string; expectDecompose: boolean }> = [
    // Elaboration — should trigger decompose and multi-angle retrieval
    {
      prompt: 'Elaborate on how the query research orchestrator works and what stopping conditions it uses',
      expectDecompose: true,
    },
    {
      prompt: 'Expand on the chat session flow and how tool rounds are handled',
      expectDecompose: true,
    },
    // Direct lookup — should NOT trigger decompose; one clean retrieval
    {
      prompt: 'What does TsMorphIndexer export?',
      expectDecompose: false,
    },
    {
      prompt: 'Where is kbIndexDbPath defined?',
      expectDecompose: false,
    },
  ]

  const results: TurnResult[] = []

  for (const { prompt, expectDecompose } of scenarios) {
    process.stderr.write(`\nRunning: "${prompt.slice(0, 60)}…"\n`)
    const result = await runScenario(prompt, base, expectDecompose, cwd, config, llmProvider)
    results.push(result)
    process.stderr.write(`  ${result.reason}\n`)
    if (result.queryLines.length > 0) {
      process.stderr.write(`  queries: ${result.queryLines.join(' | ')}\n`)
    }
    process.stderr.write(`  answer: ${result.answer.slice(0, 120)}…\n`)
  }

  const passed = results.filter(r => r.passed).length
  const total = results.length
  process.stderr.write(`\n${'─'.repeat(60)}\n`)
  process.stderr.write(`Results: ${passed}/${total} passed\n`)

  process.stdout.write(`${JSON.stringify({ base, results }, null, 2)}\n`)
  process.exit(passed === total ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
