import process from 'node:process'
import { ensureOperationalBaseDir } from '../src/cli/base-selection.js'
import { type ChatIO, type ChatTurnTrace, runChatSession } from '../src/cli/chat-cli.js'
import { runKbInit } from '../src/cli/init-cli.js'
import {
  createLLMProviderFromConfig,
  readKbConfig,
} from '../src/cli/kb-config.js'
import { DefaultIntentRouter } from '../src/intents/router.js'
import { DuckGraphWriter } from '../src/tools/duck-graph-writer.js'
import { invalidateFactTool } from '../src/tools/invalidate-fact-tool.js'
import { createKBToolsRegistry } from '../src/tools/kb-tools-registry.js'

interface EvalVariant {
  label: string
  base: string
  conversationalRetrieval: boolean
}

interface ScenarioResult {
  scenario: string
  prompts: string[]
  traces: ChatTurnTrace[]
  outputs: string[]
  score: number
  notes: string[]
}

class ScriptedChatIO implements ChatIO {
  public readonly outputs: string[] = []

  constructor(private readonly inputs: string[]) {}

  async read(): Promise<string | null> {
    return this.inputs.shift() ?? null
  }

  write(line: string): void {
    this.outputs.push(line)
  }

  error(line: string): void {
    this.outputs.push(line)
  }
}

async function main(): Promise<void> {
  const args = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (key?.startsWith('--') && value) {
      args.set(key, value)
    }
  }

  const cwd = args.get('--cwd') ?? process.cwd()
  const baseA = args.get('--base-a') ?? 'eval-chat-a'
  const baseB = args.get('--base-b') ?? 'eval-chat-b'

  const config = await readKbConfig()
  const llmProvider = createLLMProviderFromConfig(config)
  if (!llmProvider) {
    throw new Error(
      'No configured LLM provider found. Set credentials in ~/.kb/config.json or env before running this eval.'
    )
  }

  for (const base of [baseA, baseB]) {
    await runKbInit({
      base,
      cwd,
      provider: llmProvider,
      nonInteractive: true,
    })
  }

  const variants: EvalVariant[] = [
    { label: 'baseline-a', base: baseA, conversationalRetrieval: false },
    { label: 'conversational-a', base: baseA, conversationalRetrieval: true },
    { label: 'conversational-b', base: baseB, conversationalRetrieval: true },
  ]

  const report = await Promise.all(
    variants.map(variant => runVariant(variant, config, llmProvider, cwd))
  )

  const followUp = compareScenario(report, 'follow-up-search')
  const submit = compareScenario(report, 'submit-propagation')
  const invalidate = compareScenario(report, 'invalidate-propagation')

  console.log(
    JSON.stringify(
      {
        cwd,
        initializedBases: [baseA, baseB],
        comparison: {
          followUp,
          submit,
          invalidate,
          sameBaseA: {
            followUp: comparePair(report, 'follow-up-search', 'baseline-a', 'conversational-a'),
            submit: comparePair(report, 'submit-propagation', 'baseline-a', 'conversational-a'),
            invalidate: comparePair(
              report,
              'invalidate-propagation',
              'baseline-a',
              'conversational-a'
            ),
          },
          totalScoreByVariant: Object.fromEntries(
            report.map(variant => [
              variant.label,
              variant.results.reduce((total, result) => total + result.score, 0),
            ])
          ),
        },
        variants: report,
      },
      null,
      2
    )
  )
}

async function runVariant(
  variant: EvalVariant,
  config: Awaited<ReturnType<typeof readKbConfig>>,
  llmProvider: NonNullable<ReturnType<typeof createLLMProviderFromConfig>>,
  cwd: string
): Promise<{
  label: string
  base: string
  conversationalRetrieval: boolean
  results: ScenarioResult[]
}> {
  const baseDir = await ensureOperationalBaseDir(variant.base, cwd)
  const toolExecutor = createKBToolsRegistry(baseDir, config)
  const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(baseDir))

  const router = new DefaultIntentRouter(toolExecutor)

  const followUpResult = await runScenario({
    name: 'follow-up-search',
    prompts: ['Explain the agent loop', 'What about TUI?', 'Yeah let’s do the search'],
    toolExecutor,
    graphWriter,
    llmProvider,
    conversationalRetrieval: variant.conversationalRetrieval,
    scorer(result) {
      const lastTrace = result.traces[result.traces.length - 1]
      const score = [
        lastTrace?.resolvedQuery !== 'Yeah let’s do the search',
        /tui/i.test(lastTrace?.resolvedQuery ?? ''),
        result.outputs.some(line => /sources> .*tui|assistant> .*tui/i.test(line)),
      ].filter(Boolean).length

      return {
        score,
        notes: [`final resolved query: ${lastTrace?.resolvedQuery ?? 'n/a'}`],
      }
    },
  })

  await router.execute({
    intent: 'submit_fact',
    payload: {
      fact: 'Release process uses GitHub Actions.',
      domain: 'ops',
      source: 'eval',
    },
  })

  const submitResult = await runScenario({
    name: 'submit-propagation',
    prompts: ['What is the release process?'],
    toolExecutor,
    graphWriter,
    llmProvider,
    conversationalRetrieval: variant.conversationalRetrieval,
    scorer(result) {
      const score = result.outputs.some(line => /GitHub Actions/i.test(line)) ? 2 : 0
      return {
        score,
        notes: [
          `submit answer mentions GitHub Actions: ${String(result.outputs.some(line => /GitHub Actions/i.test(line)))}`,
        ],
      }
    },
  })

  await invalidateFactTool(
    {
      oldFact: 'Release process uses GitHub Actions.',
      replacementFact: 'Release process uses Buildkite.',
      preview: false,
    },
    baseDir
  )

  const invalidateResult = await runScenario({
    name: 'invalidate-propagation',
    prompts: ['What is the release process?', 'Explain it more.'],
    toolExecutor,
    graphWriter,
    llmProvider,
    conversationalRetrieval: variant.conversationalRetrieval,
    scorer(result) {
      const buildkiteSeen = result.outputs.some(line => /Buildkite/i.test(line))
      const staleSeen = result.outputs.some(line => /GitHub Actions/i.test(line))
      return {
        score: [buildkiteSeen, !staleSeen].filter(Boolean).length,
        notes: [
          `invalidate answer mentions Buildkite: ${String(buildkiteSeen)}`,
          `invalidate answer avoids stale GitHub Actions: ${String(!staleSeen)}`,
        ],
      }
    },
  })

  return {
    label: variant.label,
    base: variant.base,
    conversationalRetrieval: variant.conversationalRetrieval,
    results: [followUpResult, submitResult, invalidateResult],
  }
}

async function runScenario(input: {
  name: string
  prompts: string[]
  toolExecutor: ReturnType<typeof createKBToolsRegistry>
  graphWriter: DuckGraphWriter | undefined
  llmProvider: NonNullable<ReturnType<typeof createLLMProviderFromConfig>>
  conversationalRetrieval: boolean
  scorer: (result: { traces: ChatTurnTrace[]; outputs: string[] }) => {
    score: number
    notes: string[]
  }
}): Promise<ScenarioResult> {
  const traces: ChatTurnTrace[] = []
  const io = new ScriptedChatIO([...input.prompts, '/exit'])

  await runChatSession(
    {
      llmProvider: input.llmProvider,
      toolExecutor: input.toolExecutor,
      graphWriter: input.graphWriter,
      conversationalRetrieval: input.conversationalRetrieval,
      onTurnComplete: turn => traces.push(turn),
    },
    io
  )

  const scored = input.scorer({ traces, outputs: io.outputs })
  return {
    scenario: input.name,
    prompts: input.prompts,
    traces,
    outputs: io.outputs,
    score: scored.score,
    notes: scored.notes,
  }
}

function compareScenario(
  report: Array<{ label: string; results: ScenarioResult[] }>,
  scenario: string
): { winner: string; scores: Record<string, number> } {
  const scores = Object.fromEntries(
    report.map(variant => [
      variant.label,
      variant.results.find(result => result.scenario === scenario)?.score ?? 0,
    ])
  )

  const entries = Object.entries(scores).sort((left, right) => right[1] - left[1])
  const winner = entries[0]?.[1] === entries[1]?.[1] ? 'tie' : (entries[0]?.[0] ?? 'unknown')
  return { winner, scores }
}

function comparePair(
  report: Array<{ label: string; results: ScenarioResult[] }>,
  scenario: string,
  leftLabel: string,
  rightLabel: string
): { winner: string; scores: Record<string, number> } {
  const scores = {
    [leftLabel]:
      report
        .find(variant => variant.label === leftLabel)
        ?.results.find(result => result.scenario === scenario)?.score ?? 0,
    [rightLabel]:
      report
        .find(variant => variant.label === rightLabel)
        ?.results.find(result => result.scenario === scenario)?.score ?? 0,
  }
  const winner =
    scores[leftLabel] === scores[rightLabel]
      ? 'tie'
      : scores[leftLabel] > scores[rightLabel]
        ? leftLabel
        : rightLabel
  return { winner, scores }
}

main().catch(error => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(message)
  process.exitCode = 1
})
