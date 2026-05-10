import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enrichReadDocumentsAnswerWithLLM,
  executeIntentCommand,
  formatIntentResult,
  isIntentCommand,
  parseIntentCommand,
  printIntentHelp,
  printIntentResult,
  printReadDocumentsOrchestrationFooter,
  rewriteIntentInputWithSessionContext,
} from '../../src/cli/intent-cli'
import type { ToolExecutor } from '../../src/core/tool-registry'
import type { LLMProvider } from '../../src/core/types'
import { isOrchestrationMetaLine } from '../../src/ui/orchestration-meta'
import { createPrinter } from '../../src/ui/printer'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-intent-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('intent-cli parsing', () => {
  it('parses submit with supported payload fields only', () => {
    const parsed = parseIntentCommand([
      'submit',
      'Deployments need flag X',
      '--domain',
      'ops',
      '--include-session-logs',
    ])
    expect(parsed.envelope.intent).toBe('submit_fact')
    expect(parsed.envelope.payload.fact).toBe('Deployments need flag X')
    expect(parsed.envelope.payload.domain).toBe('ops')
    expect(parsed.envelope.payload.includeSessionLogs).toBe(true)
    expect(Object.keys(parsed.envelope.payload)).not.toContain('targetDocumentId')
  })

  it('parses query flags and query session support', () => {
    const parsed = parseIntentCommand([
      'query',
      'how do i install kb',
      '--base',
      'test-init',
      '--limit',
      '3',
      '--discovery',
      'deep',
      '--session',
      '--verbose',
      '--debug',
    ])

    expect(parsed.base).toBe('test-init')
    expect(parsed.envelope.intent).toBe('query_truth')
    expect(parsed.envelope.payload.query).toBe('how do i install kb')
    expect(parsed.envelope.payload.limit).toBe(3)
    expect(parsed.envelope.payload.discoveryDepth).toBe('deep')
    expect(parsed.useQuerySession).toBe(true)
    expect(parsed.verbose).toBe(true)
    expect(parsed.debug).toBe(true)
  })

  it('parses invalidate with --apply (writes)', () => {
    const parsed = parseIntentCommand([
      'invalidate',
      'old fact',
      'new fact',
      '--base',
      'dogfood',
      '--apply',
    ])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.envelope.intent).toBe('invalidate_fact')
    expect(parsed.envelope.payload.oldFact).toBe('old fact')
    expect(parsed.envelope.payload.replacementFact).toBe('new fact')
    expect(parsed.envelope.payload.preview).toBe(false)
  })

  it('defaults invalidate to preview (no --apply flag)', () => {
    const parsed = parseIntentCommand(['invalidate', 'old fact', 'new fact'])

    expect(parsed.envelope.payload.preview).toBe(true)
  })

  it('accepts invalidate --apply', () => {
    const parsed = parseIntentCommand(['invalidate', 'old fact', '--apply'])
    expect(parsed.envelope.payload.preview).toBe(false)
  })

  it('rejects unknown public commands', () => {
    expect(() => parseIntentCommand(['review', 'claim'])).toThrow(
      'Unsupported intent command: review'
    )
  })

  it('only treats query submit and invalidate as intent commands', () => {
    expect(isIntentCommand('query')).toBe(true)
    expect(isIntentCommand('submit')).toBe(true)
    expect(isIntentCommand('invalidate')).toBe(true)
    expect(isIntentCommand('write_document')).toBe(false)
    expect(isIntentCommand('review')).toBe(false)
  })
})

describe('intent-cli formatting', () => {
  it('formats read_facts results in human mode', () => {
    const output = formatIntentResult(
      {
        status: 'accepted',
        confidence: 0.8,
        explanation: 'query intent maps directly to read_facts',
        recommendedAction: 'read_facts',
        data: {
          answer: 'The KB uses session base first, then default base.',
          retrieval: {
            method: 'hybrid',
            detail: 'fts+vector-rerank',
            checkpoints: [
              { stage: 'hybrid_primary', status: 'hit', nextAction: 'return', confidence: 0.86 },
            ],
          },
          results: [
            {
              metadata: { id: 'cli-facts', title: 'CLI Facts', filePath: '/tmp/cli-facts.md' },
              content: '# CLI Facts\n\nKB base precedence order: 1) kb use, 2) kb default.',
            },
          ],
          total: 1,
        },
      },
      'human'
    )

    expect(output).toContain('The KB uses session base first, then default base.')
    expect(output).toContain('retrieval> hybrid (fts+vector-rerank)')
    expect(output).toContain('matches> 1')
    expect(output).toContain('sources> cli-facts')
  })

  it('prints minimal intent help with only the supported commands', () => {
    const help = printIntentHelp()
    expect(help).toContain('submit "<fact>"')
    expect(help).toContain('query "<topic>"')
    expect(help).toContain('invalidate "<old-fact>"')
  })

  it('renders orchestration footer through printer helpers', () => {
    const lines: string[] = []
    const printer = createPrinter(
      {
        log: line => lines.push(line),
        error: line => lines.push(`ERR:${line}`),
        write: line => lines.push(line),
      },
      'cli'
    )

    printReadDocumentsOrchestrationFooter(
      printer,
      {
        status: 'accepted',
        recommendedAction: 'read_facts',
        confidence: 0.8,
        data: {
          retrieval: { method: 'hybrid', detail: 'fts+vector-rerank' },
          results: [{ metadata: { title: 'CLI Facts' }, content: 'KB base precedence order.' }],
        },
      },
      { verbose: true }
    )

    expect(lines.some(line => isOrchestrationMetaLine(line))).toBe(true)
  })

  it('prints invalidate results without pretending they are read_facts', () => {
    const lines: string[] = []
    const printer = createPrinter(
      {
        log: line => lines.push(line),
        error: line => lines.push(line),
        write: line => lines.push(line),
      },
      'cli'
    )

    printIntentResult(
      {
        status: 'accepted',
        explanation: 'Scanned 3 KB documents. 1 replacements in 1 documents.',
        recommendedAction: 'invalidate_fact',
        confidence: 0.8,
      },
      'human',
      printer
    )

    expect(lines.join('\n')).toContain('status> accepted')
    expect(lines.join('\n')).toContain('invalidate_fact')
  })
})

describe('intent-cli execution and enrichment', () => {
  it('executes invalidate through the router', async () => {
    const toolExecutor: ToolExecutor = {
      register: vi.fn(),
      getTools: vi.fn(() => []),
      execute: vi.fn(async toolUse => {
        if (toolUse.name === 'invalidate_fact') {
          return {
            changes: [
              { factId: 'ops-facts', title: 'Ops Facts', replaced: 1, diff: '- old\n+ new' },
            ],
            summary: 'Scanned 3 KB documents. 1 replacements in 1 documents.',
          }
        }
        if (toolUse.name === 'invalidate_graph_for_fact') {
          return { enabled: true, invalidatedRelationships: 1, documentIds: ['ops-facts'] }
        }
        return { ok: true }
      }),
    }

    const parsed = parseIntentCommand(['invalidate', 'old fact'])
    const result = await executeIntentCommand(parsed, toolExecutor)

    expect(result.status).toBe('accepted')
    expect(result.provenance).toContain('ops-facts')
  })

  it('keeps query rewrite/session fallback scoped to query only', async () => {
    const dir = await createTempDir()
    await writeFile(
      path.join(dir, 'query-session.json'),
      JSON.stringify({
        turns: [
          {
            question: 'how does kb work?',
            answer: 'It stores project knowledge.',
            timestamp: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      }),
      'utf8'
    )

    const llm: LLMProvider = {
      name: 'test',
      model: 'stub',
      call: vi.fn(async () => ({
        text: 'How does kb base selection work?',
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    } as unknown as LLMProvider

    const parsed = parseIntentCommand(['query', 'and base selection?', '--session'])
    const rewritten = await rewriteIntentInputWithSessionContext(parsed, llm, dir)
    expect(rewritten.envelope.payload.query).toBe('How does kb base selection work?')
  })

  it('enriches query answers with the LLM but does not disturb non-read results', async () => {
    const llm: LLMProvider = {
      name: 'test',
      model: 'stub',
      call: vi.fn(async () => ({
        text: 'KB uses session base first, then default base.',
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    } as unknown as LLMProvider

    const queryParsed = parseIntentCommand(['query', 'base precedence'])
    const enriched = await enrichReadDocumentsAnswerWithLLM(
      queryParsed,
      {
        status: 'accepted',
        recommendedAction: 'read_facts',
        data: {
          retrieval: { method: 'hybrid' },
          results: [
            {
              metadata: { id: 'cli-facts', title: 'CLI Facts' },
              content: '# CLI Facts\n\nKB base precedence order: 1) kb use, 2) kb default.',
            },
          ],
        },
      },
      llm
    )
    expect((enriched.data as { answer?: string }).answer).toContain('session base first')

    const invalidateParsed = parseIntentCommand(['invalidate', 'old fact'])
    const untouched = await enrichReadDocumentsAnswerWithLLM(
      invalidateParsed,
      { status: 'accepted', recommendedAction: 'invalidate_fact', data: { ok: true } },
      llm
    )
    expect((untouched.data as { ok?: boolean }).ok).toBe(true)
  })

  it('replaces insufficient LLM answer with deterministic fallback from documents', async () => {
    const llm: LLMProvider = {
      name: 'test',
      model: 'stub',
      call: vi.fn(async () => ({
        text: 'I do not have enough evidence to answer.',
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    } as unknown as LLMProvider

    const parsed = parseIntentCommand(['query', 'roadmap version history support policy'])
    const enriched = await enrichReadDocumentsAnswerWithLLM(
      parsed,
      {
        status: 'accepted',
        recommendedAction: 'read_facts',
        data: {
          retrieval: { method: 'hybrid' },
          results: [
            {
              metadata: { id: 'roadmap', title: 'Roadmap' },
              content: '# Roadmap\n\nRoadmap includes future platform backend milestones.',
            },
            {
              metadata: { id: 'history', title: 'History' },
              content:
                '# History\n\nVersion history includes release sequence and support policy updates.',
            },
          ],
        },
      },
      llm
    )

    const answer = (enriched.data as { answer?: string }).answer ?? ''
    // LLM said insufficient evidence — should fall back to a deterministic snippet, not the coverage bullet list
    expect(answer).not.toContain('Evidence-backed coverage summary:')
    expect(answer.length).toBeGreaterThan(0)
  })

  it('keeps long sufficient LLM answer unchanged', async () => {
    const llmText =
      'Raylib roadmap lists planned backend improvements and milestone items, while version history captures release sequence and policy changes across versions with specific chronology and context for support expectations.'
    const llm: LLMProvider = {
      name: 'test',
      model: 'stub',
      call: vi.fn(async () => ({
        text: llmText,
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    } as unknown as LLMProvider

    const parsed = parseIntentCommand(['query', 'roadmap version history support policy'])
    const enriched = await enrichReadDocumentsAnswerWithLLM(
      parsed,
      {
        status: 'accepted',
        recommendedAction: 'read_facts',
        data: {
          retrieval: { method: 'hybrid' },
          results: [
            {
              metadata: { id: 'roadmap', title: 'Roadmap' },
              content: '# Roadmap\n\nRoadmap includes future platform backend milestones.',
            },
          ],
        },
      },
      llm
    )

    expect((enriched.data as { answer?: string }).answer).toBe(llmText)
  })

  it('forces build/config scaffold when answer lacks required sections', async () => {
    const llm: LLMProvider = {
      name: 'test',
      model: 'stub',
      call: vi.fn(async () => ({
        text: 'Build works with standard setup.',
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    } as unknown as LLMProvider

    const parsed = parseIntentCommand(['query', 'build config flags for linux'])
    const enriched = await enrichReadDocumentsAnswerWithLLM(
      parsed,
      {
        status: 'accepted',
        recommendedAction: 'read_facts',
        data: {
          retrieval: { method: 'hybrid' },
          results: [
            {
              metadata: { id: 'build-doc', title: 'Build' },
              content:
                '# Build\n\nInstall dependencies before build.\nRun cmake && make.\nUse -D flags for options.\nLinux platform has specific package requirements.\nWarning: static link caveat.',
            },
          ],
        },
      },
      llm
    )
    const answer = (enriched.data as { answer?: string }).answer ?? ''
    expect(answer).toContain('Build/config evidence scaffold:')
    expect(answer).toContain('Prerequisites')
    expect(answer).toContain('Commands')
    expect(answer).toContain('Flags/Options')
    expect(answer).toContain('Platform Notes')
    expect(answer).toContain('Known Gotchas')
  })
})
