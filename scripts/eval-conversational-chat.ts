/**
 * Conversational chat eval — init + 3 scenarios + score.
 *
 * Usage (kb repo root, after pnpm run build):
 *   npx tsx scripts/eval-conversational-chat.ts [--base <name>] [--cwd <path>]
 *
 * --base  KB base name (default: eval-chat-<timestamp>)
 * --cwd   Directory to index (default: process.cwd())
 *
 * Scenarios:
 *   follow-up-search    Multi-turn: model must resolve follow-ups to codebase facts
 *   upsert-propagation  Upserted fact appears in next answer
 *   replace-propagation Invalidated fact is replaced; follow-up must retrieve fresh, not skip
 */
import process from 'node:process'
import { ensureOperationalBaseDir } from '../src/cli/base-selection.js'
import { type ChatIO, type ChatTurnTrace, runChatSession } from '../src/cli/chat-cli.js'
import { runKbInit } from '../src/cli/init-cli.js'
import { createLLMProviderFromConfig, readKbConfig } from '../src/cli/kb-config.js'
import { invalidateFactTool } from '../src/tools/invalidate-fact-tool.js'
import { createKBToolsRegistry } from '../src/tools/kb-tools-registry.js'

interface ScenarioResult {
  scenario: string
  prompts: string[]
  score: number
  maxScore: number
  notes: string[]
  retrieval: {
    totalQueries: number
    turnsWithRetrieval: number
    turnsTotal: number
    avgRetrievalMs: number
  }
}

class ScriptedChatIO implements ChatIO {
  public readonly outputs: string[] = []
  constructor(private readonly inputs: string[]) {}
  async read(): Promise<string | null> { return this.inputs.shift() ?? null }
  write(line: string): void { this.outputs.push(line) }
  error(line: string): void { this.outputs.push(line) }
}

function parseRetrievalTelemetry(outputs: string[]): ScenarioResult['retrieval'] {
  const timingLines = outputs.filter(l => l.startsWith('timing> '))
  const allMs: number[] = []
  let turnsWithRetrieval = 0
  for (const line of timingLines) {
    const ms = Number(line.match(/retrieval=(\d+)ms/)?.[1] ?? 0)
    allMs.push(ms)
    if (ms > 0) turnsWithRetrieval++
  }
  return {
    totalQueries: outputs.filter(l => l.startsWith('query> ')).length,
    turnsWithRetrieval,
    turnsTotal: timingLines.length,
    avgRetrievalMs: allMs.length
      ? Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length)
      : 0,
  }
}

async function runScenario(input: {
  name: string
  prompts: string[]
  toolExecutor: ReturnType<typeof createKBToolsRegistry>
  llmProvider: NonNullable<ReturnType<typeof createLLMProviderFromConfig>>
  scorer: (opts: { traces: ChatTurnTrace[]; outputs: string[] }) => { score: number; maxScore: number; notes: string[] }
}): Promise<ScenarioResult> {
  const traces: ChatTurnTrace[] = []
  const io = new ScriptedChatIO([...input.prompts, '/exit'])
  await runChatSession(
    { llmProvider: input.llmProvider, toolExecutor: input.toolExecutor, onTurnComplete: t => traces.push(t) },
    io
  )
  const scored = input.scorer({ traces, outputs: io.outputs })
  return {
    scenario: input.name,
    prompts: input.prompts,
    score: scored.score,
    maxScore: scored.maxScore,
    notes: scored.notes,
    retrieval: parseRetrievalTelemetry(io.outputs),
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const get = (flag: string) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined }

  const cwd = get('--cwd') ?? process.cwd()
  const base = get('--base') ?? `eval-chat-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`

  const config = await readKbConfig()
  const llmProvider = createLLMProviderFromConfig(config)
  if (!llmProvider) throw new Error('No LLM provider configured — check ~/.kb/config.json.')

  process.stderr.write(`[eval-chat] base=${base} cwd=${cwd}\n`)
  process.stderr.write('[eval-chat] init...\n')
  await runKbInit({ base, cwd, provider: llmProvider, nonInteractive: true })

  const baseDir = await ensureOperationalBaseDir(base, cwd)
  const toolExecutor = createKBToolsRegistry(baseDir, config)

  process.stderr.write('[eval-chat] running scenarios...\n')

  // Scenario 1: follow-up resolution
  const followUp = await runScenario({
    name: 'follow-up-search',
    prompts: ['Explain the agent loop', 'What about TUI?', "Yeah let's do the search"],
    toolExecutor,
    llmProvider,
    scorer({ traces, outputs }) {
      const lastTrace = traces[traces.length - 1]
      const tel = parseRetrievalTelemetry(outputs)
      const checks = [
        lastTrace?.resolvedQuery !== "Yeah let's do the search",
        /tui/i.test(lastTrace?.resolvedQuery ?? ''),
        outputs.some(l => /sources> .*tui|assistant> .*tui/i.test(l)),
        tel.turnsWithRetrieval === tel.turnsTotal,
      ]
      return {
        score: checks.filter(Boolean).length,
        maxScore: checks.length,
        notes: [
          `resolved query: ${lastTrace?.resolvedQuery ?? 'n/a'}`,
          `retrieval: ${tel.turnsWithRetrieval}/${tel.turnsTotal} turns, ${tel.totalQueries} queries`,
        ],
      }
    },
  })

  // Scenario 2: upserted fact visible in answer
  await toolExecutor.execute({
    name: 'upsert_fact',
    input: { factText: 'Release process uses GitHub Actions.', sourceKind: 'import_doc', sourceRef: 'eval', confidence: 0.9 },
  })
  const upsert = await runScenario({
    name: 'upsert-propagation',
    prompts: ['What is the release process?'],
    toolExecutor,
    llmProvider,
    scorer({ outputs }) {
      const seen = outputs.some(l => /GitHub Actions/i.test(l))
      return {
        score: seen ? 2 : 0,
        maxScore: 2,
        notes: [`mentions GitHub Actions: ${String(seen)}`],
      }
    },
  })

  // Scenario 3: invalidated fact replaced; follow-up must retrieve, not skip
  await invalidateFactTool(
    { oldFact: 'Release process uses GitHub Actions.', replacementFact: 'Release process uses Buildkite.', preview: false },
    baseDir
  )
  const replace = await runScenario({
    name: 'replace-propagation',
    prompts: ['What is the release process?', 'Explain it more.'],
    toolExecutor,
    llmProvider,
    scorer({ outputs }) {
      const tel = parseRetrievalTelemetry(outputs)
      const buildkite = outputs.some(l => /Buildkite/i.test(l))
      const stale = outputs.some(l => /GitHub Actions/i.test(l))
      const checks = [buildkite, !stale, tel.turnsWithRetrieval === tel.turnsTotal]
      return {
        score: checks.filter(Boolean).length,
        maxScore: checks.length,
        notes: [
          `mentions Buildkite: ${String(buildkite)}`,
          `avoids stale GitHub Actions: ${String(!stale)}`,
          `retrieval: ${tel.turnsWithRetrieval}/${tel.turnsTotal} turns retrieved`,
        ],
      }
    },
  })

  const results = [followUp, upsert, replace]
  const totalScore = results.reduce((s, r) => s + r.score, 0)
  const totalMax = results.reduce((s, r) => s + r.maxScore, 0)

  process.stderr.write(`[eval-chat] done — ${totalScore}/${totalMax}\n`)

  console.log(JSON.stringify({ base, cwd, totalScore, totalMax, results }, null, 2))
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack : String(err))
  process.exitCode = 1
})
