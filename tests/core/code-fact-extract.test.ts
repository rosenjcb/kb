import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractCodeFactsForFile,
  extractCodeSkeleton,
  ingestCodeFilesAsFacts,
  rankCodeFilesForFacts,
} from '../../src/core/code-fact-extract'
import type { LLMCallParams, LLMProvider, LLMResponse } from '../../src/core/types'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

function makeStubProvider(scriptedReplies: string[]): LLMProvider & { calls: LLMCallParams[] } {
  const calls: LLMCallParams[] = []
  let i = 0
  const provider: LLMProvider & { calls: LLMCallParams[] } = {
    name: 'stub',
    model: 'stub-1',
    supportsStreaming: false,
    calls,
    async call(params: LLMCallParams): Promise<LLMResponse> {
      calls.push(params)
      const text = scriptedReplies[Math.min(i, scriptedReplies.length - 1)] ?? ''
      i += 1
      return {
        text,
        stopReason: 'end_turn',
        toolUses: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }
    },
  }
  return provider
}

describe('extractCodeSkeleton', () => {
  it('finds top-level TS exports, imports, and the leading doc block', () => {
    const filePath = 'src/foo/bar.ts'
    const contents = [
      '/**',
      ' * Bar module — orchestrates baz.',
      ' */',
      'import { helper } from "./helper"',
      'import path from "node:path"',
      '',
      'export function alpha(x: number) {',
      '  return helper(x)',
      '}',
      '',
      'export class BazRunner {}',
      '',
      'export const CONST_VAL = 42',
      '',
      'export default function defFn() { return 0 }',
    ].join('\n')

    const skel = extractCodeSkeleton(filePath, contents)
    expect(skel.language).toBe('typescript')
    expect(skel.leadingDoc).toContain('Bar module')
    expect(skel.exports.map(e => e.name)).toEqual(
      expect.arrayContaining(['alpha', 'BazRunner', 'CONST_VAL', 'defFn'])
    )
    expect(skel.imports.map(i => i.source)).toEqual(['./helper', 'node:path'])
  })

  it('returns empty exports for a content-free file', () => {
    const skel = extractCodeSkeleton('src/empty.ts', '\n\n')
    expect(skel.exports).toEqual([])
    expect(skel.imports).toEqual([])
  })

  it('detects Python def / class as exports', () => {
    const py = ['"""Mod docstring."""', '', 'def alpha():', '    return 1', '', 'class Beta:', '    pass'].join(
      '\n'
    )
    const skel = extractCodeSkeleton('src/mod.py', py)
    expect(skel.language).toBe('python')
    expect(skel.exports.map(e => e.name)).toEqual(expect.arrayContaining(['alpha', 'Beta']))
    expect(skel.leadingDoc).toBe('Mod docstring.')
  })
})

describe('rankCodeFilesForFacts', () => {
  it('treats explicit empty candidates as no files (rescan zero-delta)', () => {
    const codeFiles = { 'src/a.ts': 'hello', 'b.ts': 'world' }
    expect(rankCodeFilesForFacts(codeFiles, [], 10)).toEqual([])
  })

  it('prefers src/ over scripts/tests and clamps to maxFiles', () => {
    const codeFiles: Record<string, string> = {
      'tests/foo.test.ts': 'a'.repeat(2000),
      'src/foo.ts': 'b'.repeat(2000),
      'scripts/build.ts': 'c'.repeat(2000),
      'src/bar.ts': 'd'.repeat(800),
      'node_modules/dep.ts': 'e'.repeat(2000),
    }
    const ranked = rankCodeFilesForFacts(codeFiles, undefined, 3)
    expect(ranked.length).toBe(3)
    expect(ranked.includes('node_modules/dep.ts')).toBe(false)
    expect(ranked[0]?.startsWith('src/')).toBe(true)
  })
})

describe('extractCodeFactsForFile', () => {
  it('parses a clean JSON reply and constrains anchors to known symbols', async () => {
    const filePath = 'src/example.ts'
    const contents = [
      'export function alpha() { return 1 }',
      'export class Beta { run() { return 2 } }',
    ].join('\n')
    const reply = JSON.stringify({
      module_summary: 'Example module exposing alpha and Beta runner.',
      facts: [
        {
          sentence: 'alpha returns the constant 1.',
          anchor: 'alpha',
          triplet: { subject: 'alpha', predicate: 'returns', object: 'the constant 1' },
        },
        {
          sentence: 'Beta encapsulates a run method that returns 2.',
          anchor: 'Beta',
          triplet: { subject: 'Beta', predicate: 'encapsulates', object: 'a run method returning 2' },
        },
        {
          sentence: 'Bogus claim about a symbol nobody declared here today.',
          anchor: 'Gamma',
          triplet: { subject: 'Gamma', predicate: 'is', object: 'unrelated' },
        },
      ],
    })
    const provider = makeStubProvider([reply])
    const out = await extractCodeFactsForFile({ llm: provider, filePath, contents })
    expect(out.moduleSummary).toContain('Example module')
    expect(out.facts).toHaveLength(3)
    const gamma = out.facts.find(f => f.triplet.subject === 'Gamma')
    expect(gamma?.anchor).toBe('module')
  })

  it('drops the call gracefully when the model returns junk', async () => {
    const provider = makeStubProvider(['this is not json at all'])
    const out = await extractCodeFactsForFile({
      llm: provider,
      filePath: 'src/x.ts',
      contents: 'export function x() {}',
    })
    expect(out.moduleSummary).toBeNull()
    expect(out.facts).toEqual([])
  })

  it('drops malformed entries while keeping valid ones', async () => {
    const reply = JSON.stringify({
      module_summary: '   ',
      facts: [
        { sentence: 'too', anchor: 'alpha' },
        { sentence: 'alpha returns the constant 1.', anchor: 'alpha', triplet: { subject: '', predicate: 'returns', object: '1' } },
        { sentence: 'alpha returns the constant 1.', anchor: 'alpha', triplet: { subject: 'alpha', predicate: 'returns', object: '1' } },
      ],
    })
    const provider = makeStubProvider([reply])
    const out = await extractCodeFactsForFile({
      llm: provider,
      filePath: 'src/x.ts',
      contents: 'export function alpha() { return 1 }',
    })
    expect(out.moduleSummary).toBeNull()
    expect(out.facts).toHaveLength(1)
    expect(out.facts[0]?.anchor).toBe('alpha')
  })
})

describe('ingestCodeFilesAsFacts', () => {
  it('writes import_code rows with code:<path>@<anchor> source refs and is idempotent on rerun', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-code-facts-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const filePath = 'src/example.ts'
    const contents = [
      '/** Example module orchestrating alpha and Beta. */',
      'export function alpha() { return 1 }',
      'export class Beta { run() { return 2 } }',
    ].join('\n')

    const reply = JSON.stringify({
      module_summary: 'Example module exposing alpha and Beta.',
      facts: [
        {
          sentence: 'alpha returns the constant 1 to its caller.',
          anchor: 'alpha',
          triplet: { subject: 'alpha', predicate: 'returns', object: 'the constant 1' },
        },
        {
          sentence: 'Beta exposes a run method returning 2 to its caller.',
          anchor: 'Beta',
          triplet: { subject: 'Beta', predicate: 'exposes', object: 'run returning 2' },
        },
      ],
    })

    const provider = makeStubProvider([reply, reply])

    const first = await ingestCodeFilesAsFacts({
      baseDir,
      llm: provider,
      codeFiles: { [filePath]: contents },
    })
    expect(first.filesProcessed).toBe(1)
    expect(first.factsInserted).toBeGreaterThanOrEqual(2)

    const ix = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      const rows = ix.listActiveFactsBySourceRefPrefix(`code:${filePath}@`)
      expect(rows.length).toBeGreaterThanOrEqual(2)
      expect(rows.every(r => r.source_kind === 'import_code')).toBe(true)
      expect(rows.some(r => r.source_ref?.startsWith(`code:${filePath}@`))).toBe(true)
    } finally {
      ix.close()
    }

    const second = await ingestCodeFilesAsFacts({
      baseDir,
      llm: provider,
      codeFiles: { [filePath]: contents },
    })
    expect(second.factsInserted).toBe(0)
    expect(second.factsTombstoned).toBe(0)
    expect(second.factsUnchanged).toBeGreaterThanOrEqual(2)
  })

  it('supersedes a reworded anchor and tombstones a removed anchor on rescan', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-code-facts-repair-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const filePath = 'src/example.ts'
    const v1Contents = [
      '/** Example module v1. */',
      'export function alpha() { return 1 }',
      'export class Beta { run() { return 2 } }',
    ].join('\n')
    const v1Reply = JSON.stringify({
      module_summary: 'Example module v1.',
      facts: [
        { sentence: 'alpha returns 1 to its caller.', anchor: 'alpha', triplet: { subject: 'alpha', predicate: 'returns', object: '1' } },
        { sentence: 'Beta exposes a run method returning 2.', anchor: 'Beta', triplet: { subject: 'Beta', predicate: 'exposes', object: 'run' } },
      ],
    })

    const v2Contents = [
      '/** Example module v2 — Beta removed; alpha now returns the universal constant. */',
      'export function alpha() { return 42 }',
      '// supporting helper kept here so the file clears the minimum length guard easily',
    ].join('\n')
    const v2Reply = JSON.stringify({
      module_summary: 'Example module v2.',
      facts: [
        { sentence: 'alpha now returns 42 instead of 1.', anchor: 'alpha', triplet: { subject: 'alpha', predicate: 'returns', object: '42' } },
      ],
    })

    const provider = makeStubProvider([v1Reply, v2Reply])

    await ingestCodeFilesAsFacts({
      baseDir,
      llm: provider,
      codeFiles: { [filePath]: v1Contents },
    })
    const repaired = await ingestCodeFilesAsFacts({
      baseDir,
      llm: provider,
      codeFiles: { [filePath]: v2Contents },
    })

    expect(repaired.factsSuperseded + repaired.factsInserted).toBeGreaterThanOrEqual(1)
    expect(repaired.factsTombstoned).toBeGreaterThanOrEqual(1)

    const ix = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      const active = ix.listActiveFactsBySourceRefPrefix(`code:${filePath}@`)
      const anchors = new Set(
        active
          .map(r => {
            const ref = r.source_ref ?? ''
            const at = ref.indexOf('@')
            const rest = at === -1 ? '' : ref.slice(at + 1)
            const hashIdx = rest.indexOf('#')
            return hashIdx === -1 ? rest : rest.slice(0, hashIdx)
          })
          .filter(Boolean)
      )
      expect(anchors.has('alpha')).toBe(true)
      expect(anchors.has('Beta')).toBe(false)

      const alphaRows = active.filter(r => r.source_ref?.includes('@alpha#'))
      expect(alphaRows.length).toBe(1)
      expect(alphaRows[0]?.fact_text.toLowerCase()).toContain('42')
    } finally {
      ix.close()
    }
  })

  it('skips files when no provider returns facts and tracks failures', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-code-facts-fail-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const provider: LLMProvider = {
      name: 'fail',
      model: 'fail-1',
      supportsStreaming: false,
      async call(): Promise<LLMResponse> {
        throw new Error('upstream down')
      },
    }
    const out = await ingestCodeFilesAsFacts({
      baseDir,
      llm: provider,
      codeFiles: {
        'src/x.ts': '/** doc */\nexport function x() { return 1 }\n'.padEnd(200, ' '),
      },
    })
    expect(out.filesFailed).toBe(1)
    expect(out.factsInserted).toBe(0)
  })

  it('reports file progress and remaining work while ingesting code facts', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'kb-code-facts-progress-'))
    tempDirs.push(baseDir)
    new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') }).close()

    const provider = makeStubProvider([
      JSON.stringify({
        module_summary: 'First module.',
        facts: [
          {
            sentence: 'alpha returns 1.',
            anchor: 'alpha',
            triplet: { subject: 'alpha', predicate: 'returns', object: '1' },
          },
        ],
      }),
    ])

    const snapshots: Array<{
      filesCompleted: number
      filesRemaining: number
      filesProcessed: number
      filesSkippedTooSmall: number
      factsInserted: number
    }> = []

    const out = await ingestCodeFilesAsFacts({
      baseDir,
      llm: provider,
      codeFiles: {
        'src/a.ts': '/** A */\nexport function alpha() { return 1 }\n'.padEnd(200, ' '),
        'src/tiny.ts': 'export const x = 1',
      },
      onProgress(progress) {
        snapshots.push({
          filesCompleted: progress.filesCompleted,
          filesRemaining: progress.filesRemaining,
          filesProcessed: progress.filesProcessed,
          filesSkippedTooSmall: progress.filesSkippedTooSmall,
          factsInserted: progress.factsInserted,
        })
      },
    })

    expect(out.filesConsidered).toBe(2)
    expect(out.filesProcessed).toBe(1)
    expect(out.filesSkippedTooSmall).toBe(1)
    expect(snapshots[0]).toEqual({
      filesCompleted: 0,
      filesRemaining: 2,
      filesProcessed: 0,
      filesSkippedTooSmall: 0,
      factsInserted: 0,
    })
    expect(snapshots.at(-1)).toEqual({
      filesCompleted: 2,
      filesRemaining: 0,
      filesProcessed: 1,
      filesSkippedTooSmall: 1,
      factsInserted: 2,
    })
  })
})
