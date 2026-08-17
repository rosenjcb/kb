/**
 * Ticket 106: three subagent tuning rows (s1–s3), same fake LLM queue.
 * Optional snapshot: `WRITE_ORCHESTRATOR_MATRIX=true` writes under
 * `~/.kb/evaluations/_matrix/` (never under the repo tree).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import dayjs from 'dayjs'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamManager } from '@kb/core/core/runtime/stream-manager.js'
import type { LLMProvider, LLMResponse } from '@kb/core/core/types.js'
import { createKBToolsRegistry } from '@kb/core/tools/kb-tools-registry.js'
import { executeSubagentTask } from '@kb/core/tools/task.js'

class QueuedFakeProvider implements LLMProvider {
  readonly name = 'fake'
  readonly model = 'fake-model'
  readonly supportsStreaming = false

  constructor(private readonly queue: LLMResponse[]) {}

  async call(): Promise<LLMResponse> {
    const next = this.queue.shift()
    if (!next) {
      throw new Error('no more fake LLM responses')
    }
    return next
  }
}

function makeLongToolQueue(n: number): LLMResponse[] {
  const q: LLMResponse[] = []
  for (let i = 0; i < n; i++) {
    q.push({
      text: '',
      stopReason: 'tool_use',
      toolUses: [
        {
          id: `tu-${i}`,
          name: 'read_facts',
          input: { query: `step-${i}`, includeContent: true, limit: 2 },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
    })
  }
  q.push({
    text: 'done.',
    stopReason: 'end_turn',
    toolUses: [],
    usage: { inputTokens: 1, outputTokens: 2 },
  })
  return q
}

describe('subagent scenario matrix (106)', () => {
  const scenarios = ['s1', 's2', 's3'] as const
  const prevScenario = process.env.KB_SUBAGENT_SCENARIO

  afterEach(() => {
    if (prevScenario === undefined) {
      delete process.env.KB_SUBAGENT_SCENARIO
    } else {
      process.env.KB_SUBAGENT_SCENARIO = prevScenario
    }
  })

  it('[TC-7PGN] runs orchestrator scenario matrix (optional home snapshot)', async () => {
    const rows: Array<{
      scenario: string
      status: string
      profileId?: string
      readToolCalls: number
      inputTokens: number
      outputTokens: number
      error?: string
    }> = []

    for (const scenario of scenarios) {
      process.env.KB_SUBAGENT_SCENARIO = scenario

      const baseDir = path.join(
        process.cwd(),
        'tmp-scenario-matrix',
        `${scenario}-${Math.random().toString(36).slice(2)}`
      )
      await mkdir(baseDir, { recursive: true })
      try {
        const provider = new QueuedFakeProvider(makeLongToolQueue(6))
        const sm = new StreamManager()
        const registry = createKBToolsRegistry(baseDir, undefined, {
          taskProvider: provider,
          streamManager: sm,
        })
        const res = await executeSubagentTask({
          parentRegistry: registry,
          provider,
          input: {
            prompt: 'matrix probe',
            max_turns: 20,
          },
          streamManager: sm,
          parentChannelId: 'matrix',
        })
        const readToolCalls = res.toolCalls.filter(c => c.name === 'read_facts' && c.ok).length
        rows.push({
          scenario,
          status: res.status,
          profileId: res.profileId,
          readToolCalls,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          error: res.error,
        })
      } finally {
        await rm(path.join(process.cwd(), 'tmp-scenario-matrix'), { recursive: true, force: true })
      }
    }

    const s1Row = rows.find(r => r.scenario === 's1')
    const s2Row = rows.find(r => r.scenario === 's2')
    const s3Row = rows.find(r => r.scenario === 's3')
    expect(s1Row?.status).toBe('success')
    expect(s2Row?.status).toBe('success')
    expect(s3Row?.status).toBe('success')
    expect(s2Row?.readToolCalls).toBe(3)
    expect(s1Row?.readToolCalls).toBe(6)
    expect(s3Row?.readToolCalls).toBe(6)
    expect(s3Row?.profileId).toBe('research')

    if (process.env.WRITE_ORCHESTRATOR_MATRIX === 'true') {
      const stamp = dayjs().format('YYYY-MM-DD')
      const outDir = path.join(homedir(), '.kb', 'evaluations', '_matrix')
      await mkdir(outDir, { recursive: true })
      const outFile = path.join(outDir, `${stamp}-orchestrator-scenario-matrix.json`)
      await writeFile(
        outFile,
        `${JSON.stringify(
          {
            kind: 'orchestrator_scenario_matrix',
            createdAt: new Date().toISOString(),
            note: 'Synthetic fake-LLM traffic; KB_SUBAGENT_SCENARIO=s1|s2|s3.',
            rows,
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    }
  })
})
