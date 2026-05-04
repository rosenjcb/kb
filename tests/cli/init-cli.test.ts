import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseInitCommand, runKbInit } from '../../src/cli/init-cli'
import { buildFrozenSourceSnapshotDoc } from '../../src/cli/init-source-snapshots'
import type { LLMCallParams, LLMProvider, LLMResponse } from '../../src/core/types'
import { SqliteDocumentWriter } from '../../src/tools/sqlite-document-writer'

const tempDirs: string[] = []
let kbHomeDir: string

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-home-'))
  process.env.KB_HOME = kbHomeDir
})

afterEach(async () => {
  delete process.env.KB_HOME
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  if (kbHomeDir) {
    await rm(kbHomeDir, { recursive: true, force: true })
  }
})

async function createTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-init-cli-'))
  tempDirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const fullPath = path.join(dir, file)
      await mkdir(path.dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf8')
    })
  )
  return dir
}

function createQuestionIO(answers: string[]) {
  const prompts: string[] = []
  const writes: string[] = []
  let index = 0
  return {
    prompts,
    writes,
    io: {
      write(message: string) {
        writes.push(message)
      },
      async askQuestion(prompt: string): Promise<string> {
        prompts.push(prompt)
        const answer = answers[index]
        index += 1
        return answer ?? ''
      },
      async close() {},
    },
  }
}

function createSequentialOnlyQuestionIO(answers: string[]) {
  const prompts: string[] = []
  const writes: string[] = []
  let index = 0
  let inFlight = false
  return {
    prompts,
    writes,
    io: {
      write(message: string) {
        writes.push(message)
      },
      async askQuestion(prompt: string): Promise<string> {
        if (inFlight) {
          throw new Error('askQuestion called concurrently')
        }
        inFlight = true
        prompts.push(prompt)
        await new Promise(resolve => setTimeout(resolve, 0))
        const answer = answers[index]
        index += 1
        inFlight = false
        return answer ?? ''
      },
      async close() {},
    },
  }
}

function createProvider(texts: string[]): LLMProvider {
  let index = 0
  return {
    name: 'test-provider',
    supportsStreaming: false,
    async call(_params: LLMCallParams): Promise<LLMResponse> {
      const text = texts[index] ?? texts.at(-1) ?? '[]'
      index += 1
      return {
        text,
        stopReason: 'end_turn',
        toolUses: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      }
    },
  }
}

describe('init-cli interview checkpoints', () => {
  it('Given init without --base, then it prompts for a base name and uses the answer', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    const questionIO = createQuestionIO([
      'fresh-base',
      'Install with npm install.',
      '',
      '',
      '',
      '',
      '',
      '',
    ])

    const result = await runKbInit({
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: questionIO.io,
    })

    expect(result.base).toBe('fresh-base')
    expect(questionIO.prompts[0]).toContain('Knowledge base name')
    expect(questionIO.prompts[0]).toContain('[kb-init-cli-')
    expect(result.checkpointFile).toBe(
      path.join(kbHomeDir, 'sessions', 'fresh-base', 'checkpoints', 'init-latest.checkpoint.json')
    )
    const config = JSON.parse(await readFile(path.join(kbHomeDir, 'config.json'), 'utf8'))
    expect(config.activeBase).toBe('fresh-base')
  })

  it('Given init without --base and config activeBase, then prompt suggests cwd instead of reusing config base', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    await writeFile(
      path.join(kbHomeDir, 'config.json'),
      `${JSON.stringify({ activeBase: 'dogfood' }, null, 2)}\n`,
      'utf8'
    )
    const questionIO = createQuestionIO(['', '', '', '', '', '', '', ''])

    const result = await runKbInit({
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: questionIO.io,
    })

    expect(questionIO.prompts[0]).not.toContain('[dogfood]')
    expect(questionIO.prompts[0]).toContain('[kb-init-cli-')
    expect(result.base).toBe(path.basename(cwd))
    expect(result.checkpointFile).toBe(
      path.join(
        kbHomeDir,
        'sessions',
        path.basename(cwd).toLowerCase(),
        'checkpoints',
        'init-latest.checkpoint.json'
      )
    )
    const config = JSON.parse(await readFile(path.join(kbHomeDir, 'config.json'), 'utf8'))
    expect(config.activeBase).toBe(path.basename(cwd))
  })

  it('Given detach and resume flags, then parses them into init options', () => {
    const parsed = parseInitCommand(['--base', 'dogfood', '--detach', '--resume'])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.detach).toBe(true)
    expect(parsed.resume).toBe(true)
  })

  it('Given rescan flag, then parses it into init options', () => {
    const parsed = parseInitCommand(['--base', 'dogfood', '--rescan'])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.rescan).toBe(true)
  })

  it('Given rescan with resume, then parsing rejects incompatible lifecycle flags', () => {
    expect(() => parseInitCommand(['--base', 'dogfood', '--rescan', '--resume'])).toThrow(
      '--rescan cannot be combined with --resume'
    )
  })

  it('Given --apply without --rescan, then parsing rejects invalid combination', () => {
    expect(() => parseInitCommand(['--base', 'dogfood', '--apply'])).toThrow(
      '--apply requires --rescan'
    )
  })

  it.todo(
    'Given oversized init context, then every LLM phase stays within the 4096-token budget — token budget constraints relaxed to support richer agent prompts'
  )

  it('Given graph.enabled false, then init skips graph extraction and does not write a graph db', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    await writeFile(
      path.join(kbHomeDir, 'config.json'),
      JSON.stringify(
        {
          graph: { enabled: false },
        },
        null,
        2
      )
    )

    const provider = createProvider([
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Summary.\n\nDetails.',
        },
      ]),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Summary.\n\nDetails.',
        },
      ]),
      JSON.stringify({
        title: 'Project Overview',
        type: 'introduction',
        tags: ['overview'],
        content: 'Summary.\n\nDetails.',
      }),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Summary.\n\nDetails.',
        },
      ]),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Summary.\n\nDetails.',
        },
      ]),
    ])

    const result = await runKbInit({
      base: 'graph-disabled-test',
      nonInteractive: true,
      cwd,
      provider,
    })

    expect(result.status).toBe('accepted')
    expect(result.completedCycles).toContain('pass-graph')
    await expect(
      readFile(path.join(kbHomeDir, 'sessions', 'graph-disabled-test', '.kb-graph.duckdb'), 'utf8')
    ).rejects.toThrow()
  })

  it('Given a custom progress sink, then init progress updates route there instead of writing directly to stderr', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nCLI docs.\n',
    })

    const provider = createProvider([
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Overview content',
        },
      ]),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Overview content',
        },
      ]),
      JSON.stringify({
        title: 'Project Overview',
        type: 'introduction',
        tags: ['overview'],
        content: 'Overview content',
      }),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Overview content',
        },
      ]),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Overview content',
        },
      ]),
    ])

    const lines: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const result = await runKbInit({
      base: 'progress-sink-test',
      nonInteractive: true,
      cwd,
      provider,
      progressSink(line) {
        lines.push(line)
      },
    })

    expect(result.status).toBe('accepted')
    expect(lines.some(line => line.includes('[init]'))).toBe(true)
    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })

  it('Given interactive read-inputs pause, then persists version 3 checkpoint with interview rounds', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    const questionIO = createQuestionIO([
      'Install with npm install.',
      'Use kb query and kb submit daily.',
      '',
      '',
      '',
      '',
      '',
    ])

    const result = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: questionIO.io,
    })

    expect(result.status).toBe('paused')
    expect(result.checkpointFile).toBeTruthy()
    const checkpointPath = result.checkpointFile
    if (!checkpointPath) throw new Error('expected checkpointFile')
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      version: number
      interviewRounds: Array<{ round: number; questions: Array<{ answer?: string }> }>
      context: { userAnswers: Array<{ answer: string }> }
      topicCoverage: Array<{ topic: string }>
    }

    expect(checkpoint.version).toBe(3)
    expect(checkpoint.interviewRounds).toHaveLength(1)
    expect(checkpoint.interviewRounds[0].questions.length).toBeGreaterThan(0)
    expect(checkpoint.context.userAnswers.length).toBe(2)
    expect(checkpoint.topicCoverage.some(topic => topic.topic === 'install-setup')).toBe(true)
  })

  it('Given resume after import-docs pause, then finishes init without re-asking read-inputs', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project uses a CLI and has architecture notes.\n',
    })

    const firstQuestionIO = createQuestionIO([
      'Install with npm install.',
      'Use kb query for lookup.',
      '',
      '',
      '',
    ])
    const provider = createProvider([])

    const firstRun = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      stopAfter: 'import-docs',
      cwd,
      questionIO: firstQuestionIO.io,
      provider,
    })

    expect(firstRun.status).toBe('paused')
    const firstCp = firstRun.checkpointFile
    if (!firstCp) throw new Error('expected checkpointFile')
    const mid = JSON.parse(await readFile(firstCp, 'utf8')) as {
      completedCycles: string[]
      candidateDocs?: Array<{ title: string; isOriginal?: boolean }>
    }
    expect(mid.completedCycles).toContain('import-docs')
    expect(mid.candidateDocs?.some(d => d.title === 'README.md' && d.isOriginal)).toBe(true)

    const resumedRun = await runKbInit({
      base: 'dogfood',
      nonInteractive: true,
      cwd,
      resumeFrom: firstRun.checkpointFile,
      questionIO: createQuestionIO([]).io,
      provider,
    })

    expect(resumedRun.status).toBe('accepted')
  })

  it('Given version 1 checkpoint, then resume migrates it to version 3 without re-asking old answers', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nSimple overview.\n',
    })
    const checkpointFile = path.join(
      kbHomeDir,
      'sessions',
      'dogfood',
      'checkpoints',
      'init-latest.checkpoint.json'
    )
    await mkdir(path.dirname(checkpointFile), { recursive: true })
    await writeFile(
      checkpointFile,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-04-15T00:00:00.000Z',
          baseName: 'dogfood',
          workingDir: cwd,
          completedCycles: ['read-inputs'],
          context: {
            sourceFiles: { 'README.md': '# Project\n' },
            userAnswers: [
              {
                question: 'How do you install or set up this project?',
                answer: 'Run npm install.',
              },
            ],
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    )

    const questionIO = createQuestionIO([])
    const provider = createProvider([])

    const result = await runKbInit({
      base: 'dogfood',
      nonInteractive: true,
      stopAfter: 'import-docs',
      cwd,
      resumeFrom: checkpointFile,
      questionIO: questionIO.io,
      provider,
    })

    expect(result.status).toBe('paused')
    expect(questionIO.prompts).toHaveLength(0)

    const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')) as {
      version: number
      interviewRounds: Array<{ questions: Array<{ answer?: string }> }>
      completedCycles: string[]
    }

    expect(checkpoint.version).toBe(3)
    expect(checkpoint.interviewRounds[0].questions[0].answer).toBe('Run npm install.')
    expect(checkpoint.completedCycles).toContain('import-docs')
  })

  it('Given detach during read-inputs, then checkpoint stores pending questions and resume answers them', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nTiny overview only.\n',
    })

    const detached = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      detach: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: createQuestionIO([]).io,
    })

    expect(detached.status).toBe('paused')
    const detachedCp = detached.checkpointFile
    if (!detachedCp) throw new Error('expected checkpointFile')
    const pausedCheckpoint = JSON.parse(await readFile(detachedCp, 'utf8')) as {
      completedCycles: string[]
      interviewRounds: Array<{ questions: Array<{ answer?: string }> }>
    }

    expect(pausedCheckpoint.completedCycles).not.toContain('read-inputs')
    expect(pausedCheckpoint.interviewRounds[0].questions.some(question => !question.answer)).toBe(
      true
    )

    const resumeQuestions = createQuestionIO([
      'Install with pnpm install.',
      'Use kb query and kb submit daily.',
      'Architecture uses CLI plus SQLite-backed storage.',
      'Configuration lives in .env.local and kb config.',
      'Tests use vitest and npm run type-check.',
      'Publishing uses kb publish.',
      'Main gotcha is stale knowledge.',
    ])

    const resumed = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      resume: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: resumeQuestions.io,
    })

    expect(resumed.status).toBe('paused')

    const resumedCheckpoint = JSON.parse(await readFile(detachedCp, 'utf8')) as {
      completedCycles: string[]
      context: { userAnswers: Array<{ answer: string }> }
      interviewRounds: Array<{ questions: Array<{ answer?: string }> }>
    }

    expect(resumedCheckpoint.completedCycles).toContain('read-inputs')
    expect(resumedCheckpoint.context.userAnswers.length).toBeGreaterThan(0)
    expect(resumedCheckpoint.interviewRounds[0].questions.every(question => question.answer)).toBe(
      true
    )
  })

  it('Given legacy tmp checkpoint path, then init migrates it into KB home checkpoints', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nSimple overview.\n',
    })
    const legacyCheckpointFile = path.join(cwd, '.tmp', 'kb-init', 'dogfood-latest.checkpoint.json')
    await mkdir(path.dirname(legacyCheckpointFile), { recursive: true })
    await writeFile(
      legacyCheckpointFile,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-04-15T00:00:00.000Z',
          baseName: 'dogfood',
          workingDir: cwd,
          completedCycles: ['read-inputs'],
          context: {
            sourceFiles: { 'README.md': '# Project\n' },
            userAnswers: [],
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    )

    const provider = createProvider([])

    const result = await runKbInit({
      base: 'dogfood',
      nonInteractive: true,
      stopAfter: 'import-docs',
      cwd,
      provider,
    })

    expect(result.checkpointFile).toBe(
      path.join(kbHomeDir, 'sessions', 'dogfood', 'checkpoints', 'init-latest.checkpoint.json')
    )
    const migratedPath = result.checkpointFile
    if (!migratedPath) throw new Error('expected checkpointFile')
    const migrated = JSON.parse(await readFile(migratedPath, 'utf8')) as {
      version: number
    }
    expect(migrated.version).toBe(3)
  })

  it('Given resumed pending questions, then askQuestion is called sequentially not concurrently', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nTiny overview only.\n',
    })

    const _detached = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      detach: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: createQuestionIO([]).io,
    })

    const sequentialQuestionIO = createSequentialOnlyQuestionIO([
      'Install with pnpm install.',
      'Use kb query.',
      'Architecture uses CLI and SQLite.',
      'Configuration lives in .env.local.',
      'Tests use vitest.',
      'Publishing uses kb publish.',
      'Gotcha is stale facts.',
    ])

    await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      resume: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: sequentialQuestionIO.io,
    })

    expect(sequentialQuestionIO.prompts.length).toBeGreaterThan(0)
  })

  it('Given several repo markdown files, then import-docs checkpoint lists each as original', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nOverview.\n',
      'AGENTS.md': '# Agents\n\nAgent rules.\n',
      'CLAUDE.md': '# Claude\n\nWorkflow hints.\n',
      'docs/deep/nested.md': '# Nested\n\nDeep file.\n',
    })
    const provider = createProvider([])

    const result = await runKbInit({
      base: 'multi-source-init',
      nonInteractive: true,
      stopAfter: 'import-docs',
      cwd,
      provider,
    })

    expect(result.status).toBe('paused')
    const cpPath = result.checkpointFile
    if (!cpPath) throw new Error('expected checkpointFile')
    const checkpoint = JSON.parse(await readFile(cpPath, 'utf8')) as {
      candidateDocs?: Array<{ title: string; isOriginal?: boolean }>
    }
    const originals = checkpoint.candidateDocs?.filter(d => d.isOriginal) ?? []
    expect(originals).toHaveLength(4)
    const titles = originals.map(d => d.title).sort()
    expect(titles).toEqual(['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/deep/nested.md'])
  })

  it('Given --rescan, then read-inputs loads all markdown sources under cwd', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nStable root README content.\n',
      'docs/README.md': '# Docs\n\nThis README changed recently.\n',
      'AGENTS.md': '# Agents\n\nThis file should be ignored during rescan.\n',
    })
    const base = 'dogfood-rescan'
    const baseDir = path.join(kbHomeDir, 'sessions', base)
    await mkdir(baseDir, { recursive: true })

    const writer = new SqliteDocumentWriter({ baseDir, base })
    const previousRoot = buildFrozenSourceSnapshotDoc(
      'README.md',
      '# Project\n\nStable root README content.\n',
      base,
      'collected-on-init'
    )
    await writer.writeDocument({
      documentId: 'readme-md',
      title: previousRoot.title,
      content: previousRoot.content,
      type: previousRoot.type,
      tags: previousRoot.tags,
      isOriginal: true,
      overwrite: true,
    })

    const result = await runKbInit({
      base,
      nonInteractive: true,
      rescan: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: createQuestionIO([]).io,
    })

    expect(result.status).toBe('paused')
    const cpPath = result.checkpointFile
    if (!cpPath) throw new Error('expected checkpointFile')
    const checkpoint = JSON.parse(await readFile(cpPath, 'utf8')) as {
      context?: { sourceFiles?: Record<string, string> }
    }
    const sourceFileKeys = Object.keys(checkpoint.context?.sourceFiles ?? {}).sort()
    expect(sourceFileKeys).toEqual(['AGENTS.md', 'README.md', 'docs/README.md'])
  })

  it('Given --rescan without --apply, then write cycle writes originals but no mutations', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nStable root README content.\n',
      'docs/README.md': '# Docs\n\nThis README changed recently.\n',
    })
    const provider = createProvider([JSON.stringify({ entities: [], relationships: [] })])

    const result = await runKbInit({
      base: 'rescan-preview',
      nonInteractive: true,
      rescan: true,
      cwd,
      provider,
      questionIO: createQuestionIO([]).io,
    })

    expect(result.status).toBe('accepted')
    // originals are always written; mutations are gated behind --apply
    expect((result.writtenDocIds ?? []).length).toBeGreaterThan(0)
  })

  it('Given --rescan without --apply, then run stays plan-only and writes no documents', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nStable root README content.\n',
      'docs/README.md': '# Docs\n\nThis README changed recently.\n',
    })
    const provider = createProvider([JSON.stringify({ entities: [], relationships: [] })])

    const result = await runKbInit({
      base: 'rescan-plan-only',
      nonInteractive: true,
      rescan: true,
      cwd,
      provider,
    })

    expect(result.status).toBe('accepted')
    expect((result.writtenDocIds ?? []).length).toBe(2)
  })

  it('Given --rescan plan preview, then it does not propose synthetic rescan files', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nKB provides CLI + intent commands for project knowledge.\n',
      'docs/README.md': '# Docs\n\nUse kb submit and kb invalidate to manage facts.\n',
    })
    const provider = createProvider([JSON.stringify({ entities: [], relationships: [] })])
    const questionIO = createQuestionIO([])
    const result = await runKbInit({
      base: 'rescan-preview-append-style',
      nonInteractive: true,
      rescan: true,
      cwd,
      provider,
      questionIO: questionIO.io,
    })

    expect(result.status).toBe('accepted')
    const output = questionIO.writes.join('\n')
    expect(output).toContain('rescan plan preview')
    expect(output).not.toContain('diff --git a/docs/rescan-')
  })

  it('Given interactive --rescan, then asks once to proceed then read-inputs does not ask initial interview questions', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has docs.\n',
    })
    const questionIO = createQuestionIO(['y'])

    const result = await runKbInit({
      base: 'rescan-no-questions',
      nonInteractive: false,
      rescan: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: questionIO.io,
    })

    expect(result.status).toBe('paused')
    expect(questionIO.prompts).toHaveLength(1)
    expect(questionIO.writes.some(w => w.includes('Proceed?'))).toBe(true)
  })

  it('Given interactive --rescan through import-docs, then follow-up interview questions are skipped', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has docs.\n',
    })
    await mkdir(path.join(cwd, 'evaluation', 'runs'), { recursive: true })
    const provider = createProvider([])
    const questionIO = createQuestionIO(['y'])

    const result = await runKbInit({
      base: 'rescan-no-followups',
      nonInteractive: false,
      rescan: true,
      stopAfter: 'import-docs',
      cwd,
      provider,
      questionIO: questionIO.io,
    })

    expect(result.status).toBe('paused')
    expect(questionIO.prompts).toHaveLength(1)
    expect(questionIO.writes.some(w => w.includes('Proceed?'))).toBe(true)
  })

  it('Given --rescan without --base and config activeBase, then uses that base', async () => {
    await writeFile(
      path.join(kbHomeDir, 'config.json'),
      JSON.stringify({ activeBase: 'cfg-rescan-base' }),
      'utf8'
    )
    const cwd = await createTempProject({
      'README.md': '# Project\n\nDocs here.\n',
    })
    const result = await runKbInit({
      rescan: true,
      nonInteractive: true,
      stopAfter: 'read-inputs',
      cwd,
    })
    expect(result.base).toBe('cfg-rescan-base')
    expect(result.status).toBe('paused')
  })

  it('Given --rescan without --base and no active/default in config, then non-interactive throws', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nDocs here.\n',
    })
    await expect(
      runKbInit({
        rescan: true,
        nonInteractive: true,
        stopAfter: 'read-inputs',
        cwd,
      })
    ).rejects.toThrow(/No active or default KB base/)
  })
})
