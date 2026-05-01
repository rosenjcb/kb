import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { StreamManager } from '../../src/core/runtime/stream-manager'
import type { LLMProvider, LLMResponse } from '../../src/core/types'
import { createKBToolsRegistry } from '../../src/tools/kb-tools-registry'
import { executeSubagentTask } from '../../src/tools/task'

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

describe('executeSubagentTask', () => {
  it('Given empty prompt, then returns validation error', async () => {
    const base = path.join(
      process.cwd(),
      'tmp-task-validation',
      `b-${Math.random().toString(36).slice(2)}`
    )
    await mkdir(base, { recursive: true })
    try {
      const registry = createKBToolsRegistry(base)
      const provider = new QueuedFakeProvider([])
      const res = await executeSubagentTask({
        parentRegistry: registry,
        provider,
        input: { prompt: '   ' },
      })
      expect(res.status).toBe('error')
      expect(res.error).toMatch(/non-empty/)
    } finally {
      await rm(path.join(process.cwd(), 'tmp-task-validation'), { recursive: true, force: true })
    }
  })

  it('Given subagent read_facts turn then text turn, then succeeds with trace', async () => {
    const base = path.join(
      process.cwd(),
      'tmp-task-test',
      `base-${Math.random().toString(36).slice(2)}`
    )
    await mkdir(base, { recursive: true })
    try {
      const provider = new QueuedFakeProvider([
        {
          text: '',
          stopReason: 'tool_use',
          toolUses: [
            {
              id: 'tu-1',
              name: 'read_facts',
              input: { query: 'nothing', includeContent: true, limit: 3 },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          text: 'No matching documents.',
          stopReason: 'end_turn',
          toolUses: [],
          usage: { inputTokens: 2, outputTokens: 3 },
        },
      ])
      const sm = new StreamManager()
      const registry = createKBToolsRegistry(base, undefined, {
        taskProvider: provider,
        streamManager: sm,
      })
      const res = await executeSubagentTask({
        parentRegistry: registry,
        provider,
        input: { prompt: 'Find anything about elephants', agent_profile_id: 'research' },
        streamManager: sm,
        parentChannelId: 'sess-1',
      })
      expect(res.status).toBe('success')
      expect(res.profileId).toBe('research')
      expect(res.toolCalls.some(c => c.name === 'read_facts' && c.ok)).toBe(true)
      expect(res.textSegments.join('')).toContain('No matching')
      expect(res.usage.inputTokens + res.usage.outputTokens).toBeGreaterThan(0)
    } finally {
      await rm(path.join(process.cwd(), 'tmp-task-test'), { recursive: true, force: true })
    }
  })
})
