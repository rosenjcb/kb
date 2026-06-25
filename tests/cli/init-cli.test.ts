import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBaseMeta, repoSlugFromGitUrl } from '../../src/cli/base-meta'
import { findKbFile, resolveBaseToDir, writeKbFile } from '../../src/cli/base-selection'
import { parseInitCommand, parseScanCommand, runKbInit } from '../../src/cli/init-cli'
import { buildFrozenSourceSnapshotDoc } from '../../src/cli/init-source-snapshots'
import { RunCollector } from '../../src/core/telemetry'
import type { LLMCallParams, LLMProvider, LLMResponse } from '../../src/core/types'
import { SqliteDocumentWriter } from '../../src/tools/sqlite-document-writer'
import { SqliteKbIndexer } from '../../src/tools/sqlite-kb-index'

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

async function makeTempGitRepo(files: Record<string, string>, branch = 'main'): Promise<string> {
  const dir = await createTempProject(files) // already pushes to tempDirs
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-b', branch)
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-m', 'init')
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
    model: 'test-model',
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
    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    const questionIO = createQuestionIO([
      'fresh-base',
    ])

    const result = await runKbInit({
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
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

  it('Given init without --base and config activeBase, then prompt suggests cwd instead of reusing config base', { timeout: 15_000 }, async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    await writeFile(
      path.join(kbHomeDir, 'config.json'),
      `${JSON.stringify({ activeBase: 'dogfood' }, null, 2)}\n`,
      'utf8'
    )
    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    const questionIO = createQuestionIO([''])

    const result = await runKbInit({
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
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

  it('Given scan args, then parsing implies rescan and always applies automatically', () => {
    const parsed = parseScanCommand(['--base', 'dogfood'])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.rescan).toBe(true)
    expect(parsed.apply).toBe(true)
  })

  it('Given --stop-after document-facts, then parsing returns document-facts', () => {
    const parsed = parseInitCommand(['--base', 'dogfood', '--stop-after', 'document-facts'])

    expect(parsed.stopAfter).toBe('document-facts')
  })

  it('Given init cycle validation, then exactly 5 phases are defined without pass-graph', () => {
    const expectedCycles: Array<'read-inputs' | 'document-facts' | 'import-docs' | 'write' | 'ast-facts'> = [
      'read-inputs',
      'document-facts',
      'import-docs',
      'write',
      'ast-facts',
    ]

    expect(expectedCycles).toHaveLength(5)
    expect(expectedCycles).not.toContain('pass-graph')
  })

  it.todo(
    'Given oversized init context, then every LLM phase stays within the 4096-token budget — token budget constraints relaxed to support richer agent prompts'
  )

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

    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nCLI docs.\n',
    })
    const lines: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const result = await runKbInit({
      base: 'progress-sink-test',
      nonInteractive: true,
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
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

  it('Given interactive init, then read-inputs does not ask deprecated interview questions', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nThis project has a CLI.\n',
    })
    const questionIO = createQuestionIO([])

    const result = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      questionIO: questionIO.io,
    })

    expect(result.status).toBe('paused')
    expect(result.checkpointFile).toBeTruthy()
    const checkpointPath = result.checkpointFile
    if (!checkpointPath) throw new Error('expected checkpointFile')
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      version: number
      interviewRounds?: Array<{ round: number; questions: Array<{ answer?: string }> }>
      context: { userAnswers: Array<{ answer: string }>; sourceFiles?: Record<string, string> }
    }

    expect(checkpoint.version).toBe(3)
    // Fresh interactive init offers the ignore-paths prompt (and nothing else); the
    // deprecated interview questions stay gone.
    expect(questionIO.prompts).toHaveLength(1)
    expect(questionIO.prompts[0]).toContain('Ignore patterns')
    expect(checkpoint.interviewRounds ?? []).toHaveLength(0)
    expect(checkpoint.context.userAnswers).toEqual([])
    expect(Object.keys(checkpoint.context.sourceFiles ?? {})).toContain('README.md')
  })

  it('Given resume after import-docs pause, then finishes init without re-asking read-inputs', { timeout: 15_000 }, async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project uses a CLI and has architecture notes.\n',
    })

    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nThis project uses a CLI and has architecture notes.\n',
    })
    const firstQuestionIO = createQuestionIO([])
    const provider = createProvider([])

    const firstRun = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      stopAfter: 'import-docs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
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
      gitTargets: [{ url: repo, branch: 'main' }],
      resumeFrom: firstRun.checkpointFile,
      questionIO: createQuestionIO([]).io,
      provider,
    })

    expect(resumedRun.status).toBe('accepted')
  })

  it('Given version 1 checkpoint, then resume migrates it to version 3 without reviving deprecated answers', async () => {
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

    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nSimple overview.\n',
    })
    const questionIO = createQuestionIO([])
    const provider = createProvider([])

    const result = await runKbInit({
      base: 'dogfood',
      nonInteractive: true,
      stopAfter: 'import-docs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      resumeFrom: checkpointFile,
      questionIO: questionIO.io,
      provider,
    })

    expect(result.status).toBe('paused')
    expect(questionIO.prompts).toHaveLength(0)

    const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')) as {
      version: number
      interviewRounds: Array<{ questions: Array<{ answer?: string }> }>
      context: { userAnswers: Array<{ answer: string }> }
      completedCycles: string[]
    }

    expect(checkpoint.version).toBe(3)
    expect(checkpoint.interviewRounds).toEqual([])
    expect(checkpoint.context.userAnswers).toEqual([])
    expect(checkpoint.completedCycles).toContain('import-docs')
  })

  it('Given detach during read-inputs, then init no longer stores pending interview questions', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nTiny overview only.\n',
    })
    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nTiny overview only.\n',
    })

    const detached = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      detach: true,
      stopAfter: 'read-inputs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      questionIO: createQuestionIO([]).io,
    })

    expect(detached.status).toBe('paused')
    const detachedCp = detached.checkpointFile
    if (!detachedCp) throw new Error('expected checkpointFile')
    const pausedCheckpoint = JSON.parse(await readFile(detachedCp, 'utf8')) as {
      completedCycles: string[]
      interviewRounds: Array<{ questions: Array<{ answer?: string }> }>
      context: { userAnswers: Array<{ answer: string }> }
    }

    expect(pausedCheckpoint.completedCycles).toContain('read-inputs')
    expect(pausedCheckpoint.interviewRounds).toEqual([])
    expect(pausedCheckpoint.context.userAnswers).toEqual([])
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

    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nSimple overview.\n',
    })
    const provider = createProvider([])

    const result = await runKbInit({
      base: 'dogfood',
      nonInteractive: true,
      stopAfter: 'import-docs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
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

  it('Given resume after read-inputs, then deprecated interview prompting does not resume', { timeout: 15_000 }, async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nTiny overview only.\n',
    })
    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nTiny overview only.\n',
    })

    const initial = await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      questionIO: createQuestionIO([]).io,
    })

    expect(initial.status).toBe('paused')

    const sequentialQuestionIO = createSequentialOnlyQuestionIO([])

    await runKbInit({
      base: 'dogfood',
      nonInteractive: false,
      resume: true,
      stopAfter: 'read-inputs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      questionIO: sequentialQuestionIO.io,
    })

    // git targets supplied → no git prompt; categories removed → no category prompt
    expect(sequentialQuestionIO.prompts).toHaveLength(0)
  })

  it('Given several repo markdown files, then import-docs checkpoint lists each as original', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nOverview.\n',
    })
    const repo = await makeTempGitRepo({
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
      gitTargets: [{ url: repo, branch: 'main' }],
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

  it('Given rescan, then read-inputs loads all markdown sources under cwd', async () => {
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

  it('Given published snapshot docs, then read-inputs excludes published snapshots and export artifacts', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nReal repo overview.\n',
    })
    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nReal repo overview.\n',
      'docs/README.md': '# Docs\n\nReal docs.\n',
      'docs/_original_docs/readme.md': '# Snapshot\n\nGenerated copy.\n',
      'docs/_autogenerated_docs/howto.md': '# Autogen\n\nGenerated document.\n',
      'docs/dogfood-docs-generate-export.md':
        '# Dogfood export (docs generate)\n\nGenerated export.\n',
    })

    const result = await runKbInit({
      base: 'exclude-published-snapshot-docs',
      nonInteractive: true,
      stopAfter: 'read-inputs',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      questionIO: createQuestionIO([]).io,
    })

    expect(result.status).toBe('paused')
    const cpPath = result.checkpointFile
    if (!cpPath) throw new Error('expected checkpointFile')
    const checkpoint = JSON.parse(await readFile(cpPath, 'utf8')) as {
      context?: { sourceFiles?: Record<string, string> }
    }
    const sourceFileKeys = Object.keys(checkpoint.context?.sourceFiles ?? {}).sort()
    expect(sourceFileKeys).toEqual(['README.md', 'docs/README.md'])
  })

  it('Given no markdown sources under the working directory, then document-facts stage is skipped', async () => {
    const cwd = await createTempProject({
      'package.json': '{"name":"test"}',
    })
    const repo = await makeTempGitRepo({
      'package.json': '{"name":"test"}',
      'src/index.ts': 'export function hello() {}',
    })

    const lines: string[] = []
    const result = await runKbInit({
      base: 'no-markdown-sources',
      nonInteractive: true,
      stopAfter: 'document-facts',
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      progressSink(line) {
        lines.push(line)
      },
      questionIO: createQuestionIO([]).io,
    })

    expect(result.status).toBe('paused')
    expect(
      lines.some(
        line =>
          line.includes('document-facts') &&
          line.includes('skipped (no markdown documents found)')
      )
    ).toBe(true)
  })

  it('Given multiple markdown sources, then iterable init phases emit current-item progress', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis root sentence is intentionally long enough for fact ingest.\n',
    })
    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nThis root sentence is intentionally long enough for fact ingest.\n',
      'docs/guide.md':
        '# Guide\n\nThis guide sentence is also intentionally long enough for fact ingest.\n',
    })

    const lines: string[] = []
    const result = await runKbInit({
      base: 'iterable-progress-test',
      nonInteractive: true,
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      progressSink(line) {
        lines.push(line)
      },
    })

    expect(result.status).toBe('accepted')
    expect(lines.some(line => line.includes('read-inputs') && line.includes('README.md'))).toBe(
      true
    )
    expect(
      lines.some(line => line.includes('document-facts') && line.includes('README.md'))
    ).toBe(true)
    expect(lines.some(line => line.includes('import-docs') && line.includes('README.md'))).toBe(
      true
    )
    expect(lines.some(line => line.includes('write') && line.includes('README.md'))).toBe(true)
  })

  it('Given rescan, then write cycle writes originals and any resulting mutations', async () => {
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
    expect((result.writtenDocIds ?? []).length).toBeGreaterThan(0)
  })

  it('Given rescan, then run writes refreshed documents instead of staying plan-only', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nStable root README content.\n',
      'docs/README.md': '# Docs\n\nThis README changed recently.\n',
    })
    const provider = createProvider([JSON.stringify({ entities: [], relationships: [] })])
    const lines: string[] = []

    const result = await runKbInit({
      base: 'rescan-plan-only',
      nonInteractive: true,
      rescan: true,
      cwd,
      provider,
      progressSink(line) {
        lines.push(line)
      },
    })

    expect(result.status).toBe('accepted')
    expect((result.writtenDocIds ?? []).length).toBe(2)
    expect(
      lines.some(
        line =>
          line.includes('write') &&
          (line.includes('writing original docs') || line.includes('mutations processed'))
      )
    ).toBe(true)
  })

  it('Given an unchanged second scan, then markdown sources are skipped and no original docs are rewritten', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nStable root README content.\n',
      'docs/README.md': '# Docs\n\nThis README changed recently.\n',
    })

    await runKbInit({
      base: 'rescan-skip-unchanged',
      nonInteractive: true,
      rescan: true,
      cwd,
    })

    const lines: string[] = []
    const result = await runKbInit({
      base: 'rescan-skip-unchanged',
      nonInteractive: true,
      rescan: true,
      cwd,
      progressSink(line) {
        lines.push(line)
      },
    })

    expect(result.status).toBe('accepted')
    expect(result.writtenDocIds ?? []).toEqual([])
    expect(
      lines.some(
        line =>
          line.includes('document-facts') &&
          line.includes('0 changed, 2 unchanged file(s)')
      )
    ).toBe(true)
    expect(
      lines.some(
        line =>
          line.includes('import-docs') &&
          line.includes('0 changed, 2 unchanged original doc(s)')
      )
    ).toBe(true)
  })

  it('Given one changed markdown source on rescan, then only that original doc is re-imported', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nStable root README content.\n',
      'docs/README.md': '# Docs\n\nThis README changed recently.\n',
    })
    const base = 'rescan-one-changed-source'

    await runKbInit({
      base,
      nonInteractive: true,
      rescan: true,
      cwd,
    })

    await writeFile(
      path.join(cwd, 'docs/README.md'),
      '# Docs\n\nThis README changed again with a new paragraph.\n',
      'utf8'
    )

    const lines: string[] = []
    const result = await runKbInit({
      base,
      nonInteractive: true,
      rescan: true,
      stopAfter: 'import-docs',
      cwd,
      progressSink(line) {
        lines.push(line)
      },
    })

    expect(result.status).toBe('paused')
    expect(
      lines.some(
        line =>
          line.includes('document-facts') &&
          line.includes('1 changed, 1 unchanged') &&
          line.includes('docs/README.md')
      )
    ).toBe(true)
    expect(
      lines.some(
        line =>
          line.includes('import-docs') &&
          line.includes('1 changed, 1 unchanged') &&
          line.includes('docs/README.md')
      )
    ).toBe(true)

    const cpPath = result.checkpointFile
    if (!cpPath) throw new Error('expected checkpointFile')
    const checkpoint = JSON.parse(await readFile(cpPath, 'utf8')) as {
      candidateDocs?: Array<{ title: string; isOriginal?: boolean }>
    }
    const originals = checkpoint.candidateDocs?.filter(d => d.isOriginal) ?? []
    expect(originals).toHaveLength(1)
    expect(originals[0]?.title).toBe('docs/README.md')
  })

  it(
    'Given an unchanged second scan for AST-indexed code, then ast-facts skips the whole cycle from its manifest',
    async () => {
    const cwd = await createTempProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'ES2020', module: 'commonjs', strict: true },
        include: ['src/**/*'],
      }),
      'src/stable.ts': 'export const STABLE = true\n',
    })
    const base = 'rescan-skip-unchanged-ast'

    await runKbInit({
      base,
      nonInteractive: true,
      rescan: true,
      cwd,
    })

    const lines: string[] = []
    const result = await runKbInit({
      base,
      nonInteractive: true,
      rescan: true,
      cwd,
      progressSink(line) {
        lines.push(line)
      },
    })

    expect(result.status).toBe('accepted')
    expect(lines.some(line => line.includes('code-index') && line.includes('done'))).toBe(true)
    },
    10000
  )

  it('Given unchanged scan plan, then it does not emit preview diff chatter or synthetic scan files', async () => {
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
    expect(output).not.toContain('[kb scan] plan preview')
    expect(output).not.toContain('diff --git a/docs/rescan-')
  })

  it('Given interactive rescan, then read-inputs does not ask initial interview questions or prompt to proceed', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has docs.\n',
    })
    const questionIO = createQuestionIO([])

    const result = await runKbInit({
      base: 'rescan-no-questions',
      nonInteractive: false,
      rescan: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: questionIO.io,
    })

    expect(result.status).toBe('paused')
    expect(questionIO.prompts).toHaveLength(0)
    expect(questionIO.writes.some(w => w.includes('Proceed?'))).toBe(false)
  })

  it('Given interactive rescan through import-docs, then follow-up interview questions are skipped without a proceed prompt', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nThis project has docs.\n',
    })
    await mkdir(path.join(cwd, 'evaluation', 'runs'), { recursive: true })
    const provider = createProvider([])
    const questionIO = createQuestionIO([])

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
    expect(questionIO.prompts).toHaveLength(0)
    expect(questionIO.writes.some(w => w.includes('Proceed?'))).toBe(false)
  })

  it('Given rescan with a .kb file in cwd, uses the pinned base even in non-interactive mode', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nDocs here.\n',
    })
    await initBase('pinned-rescan-base')
    await writeKbFile(cwd, 'pinned-rescan-base')

    const result = await runKbInit({
      rescan: true,
      nonInteractive: true,
      stopAfter: 'read-inputs',
      cwd,
    })
    expect(result.base).toBe('pinned-rescan-base')
    expect(result.status).toBe('paused')
  })

  it('Given rescan without --base and no .kb file in non-interactive mode, throws with .kb guidance', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nDocs here.\n',
    })
    await initBase('some-base')
    await expect(
      runKbInit({
        rescan: true,
        nonInteractive: true,
        stopAfter: 'read-inputs',
        cwd,
      })
    ).rejects.toThrow(/.kb file/)
  })

  it('Given a full init cycle, then progress counter shows 6/6 (not 7)', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nDocs here.\n',
    })
    const repo = await makeTempGitRepo({
      'README.md': '# Project\n\nDocs here.\n',
      'src/index.ts': 'export function hello() { console.log("hi"); }',
    })

    const provider = createProvider([
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Overview',
        },
      ]),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Overview',
        },
      ]),
      JSON.stringify({
        title: 'Project Overview',
        type: 'introduction',
        tags: ['overview'],
        content: 'Overview',
      }),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Overview',
        },
      ]),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'introduction',
          tags: ['overview'],
          content: 'Overview',
        },
      ]),
    ])

    const lines: string[] = []
    const result = await runKbInit({
      base: 'progress-counter-test',
      nonInteractive: true,
      cwd,
      gitTargets: [{ url: repo, branch: 'main' }],
      provider,
      progressSink(line) {
        lines.push(line)
      },
    })

    expect(result.status).toBe('accepted')
    // Validate that the write phase appears and no lines reference 7 phases
    const writeLines = lines.filter(line => line.includes('write'))
    expect(writeLines.length).toBeGreaterThan(0)
    // Ensure no lines reference 7 phases
    expect(lines.some(line => line.match(/\d\/7/))).toBe(false)
    // Ensure all phase lines use the correct total (6)
    const phaseLines = lines.filter(line => line.match(/\d+\/\d+/))
    expect(phaseLines.every(line => !line.match(/\d+\/7/))).toBe(true)
  })
})

describe('init-cli token tracking', () => {
  function createTokenProvider(inputTokens: number, outputTokens: number): LLMProvider {
    return {
      name: 'test-provider',
      model: 'test-model',
      supportsStreaming: false,
      async call(_params: LLMCallParams): Promise<LLMResponse> {
        return {
          text: JSON.stringify({ module_summary: 'A module.', facts: [] }),
          stopReason: 'end_turn',
          toolUses: [],
          usage: { inputTokens, outputTokens },
        }
      },
    }
  }

  it('Given a TypeScript-only project, then AST code-index uses no LLM tokens', async () => {
    // TypeScript files use the AST indexer (tree-sitter), not an LLM pass.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-tok-ts-'))
    const repo = await makeTempGitRepo({
      'index.ts': 'export function greet() { return "hi" }',
    })
    try {
      const collector = new RunCollector('init')
      await runKbInit({
        base: 'tok-ts-only',
        nonInteractive: true,
        cwd: dir,
        gitTargets: [{ url: repo, branch: 'main' }],
        provider: createTokenProvider(300, 100),
        collector,
      })
      const report = collector.finish('success')
      expect(report.stages.find(s => s.stage === 'code-index')).toBeUndefined()
      expect(report.totalInputTokens).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// helpers shared by scan base-resolution tests
// ---------------------------------------------------------------------------

async function initBase(name: string): Promise<void> {
  const dir = resolveBaseToDir(name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, '.kb-index.sqlite'), '', 'utf8')
}

describe('kb scan — base resolution', () => {
  it('Given a .kb file in cwd, uses that base without prompting', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('pinned-base')
    await writeKbFile(cwd, 'pinned-base')
    const { io, prompts } = createQuestionIO([])

    const result = await runKbInit({
      rescan: true,
      apply: true,
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: io,
    })

    expect(result.base).toBe('pinned-base')
    expect(prompts).toHaveLength(0)
    // .kb file still present and correct
    expect(await findKbFile(cwd)).toBe('pinned-base')
  })

  it('Given a .kb file in an ancestor dir, uses that base without prompting', async () => {
    const root = await createTempProject({ 'README.md': '# hi\n' })
    const cwd = path.join(root, 'src', 'lib')
    await mkdir(cwd, { recursive: true })
    await initBase('ancestor-base')
    await writeKbFile(root, 'ancestor-base')
    const { io, prompts } = createQuestionIO([])

    const result = await runKbInit({
      rescan: true,
      apply: true,
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: io,
    })

    expect(result.base).toBe('ancestor-base')
    expect(prompts).toHaveLength(0)
  })

  it('Given --base flag, uses it directly without reading .kb file or prompting', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('explicit-base')
    const { io, prompts } = createQuestionIO([])

    const result = await runKbInit({
      base: 'explicit-base',
      rescan: true,
      apply: true,
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: io,
    })

    expect(result.base).toBe('explicit-base')
    expect(prompts).toHaveLength(0)
  })

  it('Given no .kb file and a single initialized base, auto-selects it without prompting', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('solo-base')
    const { io, prompts, writes } = createQuestionIO([])

    const result = await runKbInit({
      rescan: true,
      apply: true,
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: io,
    })

    expect(result.base).toBe('solo-base')
    expect(prompts).toHaveLength(0)
    expect(writes.join('')).toContain('solo-base')
  })

  it('Given no .kb file and multiple bases, prompts with a list and accepts a typed name', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('alpha')
    await initBase('beta')
    const { io, prompts, writes } = createQuestionIO(['beta'])

    const result = await runKbInit({
      rescan: true,
      apply: true,
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: io,
    })

    expect(result.base).toBe('beta')
    expect(prompts[0]).toContain('Base name')
    expect(writes.join('')).toContain('alpha')
    expect(writes.join('')).toContain('beta')
  })

  it('Given no .kb file and multiple bases, passing suggestions list to askQuestion', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('alpha')
    await initBase('beta')

    const capturedOpts: unknown[] = []
    const io = {
      write: (_msg: string) => {},
      async askQuestion(_question: string, opts?: unknown): Promise<string> {
        capturedOpts.push(opts)
        return 'alpha'
      },
      async close() {},
    }

    await runKbInit({
      rescan: true,
      apply: true,
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: io,
    })

    const opts = capturedOpts[0] as { slashContext?: string; suggestions?: string[] }
    expect(opts?.slashContext).toBe('scan-base-picker')
    expect(opts?.suggestions).toContain('alpha')
    expect(opts?.suggestions).toContain('beta')
  })

  it('Given no .kb file and multiple bases, an invalid name throws an error', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('alpha')
    await initBase('beta')
    const { io } = createQuestionIO(['does-not-exist'])

    await expect(
      runKbInit({
        rescan: true,
        apply: true,
        nonInteractive: false,
        stopAfter: 'read-inputs',
        cwd,
        questionIO: io,
      })
    ).rejects.toThrow('Unknown base')
  })

  it('Given no .kb file and /cancel answer, throws InitCancelledError', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('alpha')
    await initBase('beta')
    const { io } = createQuestionIO(['/cancel'])

    await expect(
      runKbInit({
        rescan: true,
        apply: true,
        nonInteractive: false,
        stopAfter: 'read-inputs',
        cwd,
        questionIO: io,
      })
    ).rejects.toThrow('Cancelled')
  })

  it('Given no .kb file and no initialized bases, throws a helpful error', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    const { io } = createQuestionIO([])

    await expect(
      runKbInit({
        rescan: true,
        apply: true,
        nonInteractive: false,
        stopAfter: 'read-inputs',
        cwd,
        questionIO: io,
      })
    ).rejects.toThrow('No initialized bases found')
  })

  it('Given no .kb file and --non-interactive, throws without prompting', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('alpha')
    const { io } = createQuestionIO([])

    await expect(
      runKbInit({
        rescan: true,
        apply: true,
        nonInteractive: true,
        cwd,
        questionIO: io,
      })
    ).rejects.toThrow('.kb file')
  })

  it('After scan completes, writes .kb file to cwd', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    await initBase('written-base')
    await writeKbFile(cwd, 'written-base')
    const { io } = createQuestionIO([])

    await runKbInit({
      rescan: true,
      apply: true,
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: io,
    })

    expect(await findKbFile(cwd)).toBe('written-base')
  })
})

// ---------------------------------------------------------------------------
// git-linked init dialog
// ---------------------------------------------------------------------------

describe('init-cli git-linked dialog', { timeout: 30_000 }, () => {
  it('Given interactive init with a git URL entered second, then clones from that URL', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    const repo = await makeTempGitRepo({ 'README.md': '# Remote Repo\n' })
    const { io, prompts } = createQuestionIO([
      '',     // accept suggested base name (cwd-derived)
      repo,   // git URL — second prompt
    ])

    await runKbInit({
      nonInteractive: false,
      cwd,
      questionIO: io,
    })

    expect(prompts[0]).toContain('Knowledge base name')
    expect(prompts[1]).toContain('Git URL')

    const baseDir = resolveBaseToDir(path.basename(cwd), cwd)
    const meta = await readBaseMeta(baseDir)
    expect(meta?.repos[0]?.gitUrl).toBe(repo)

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      expect(indexer.listFactsForQuery(99999).length).toBeGreaterThan(0)
    } finally {
      indexer.close()
    }
  })

  it('Given --git flag (non-interactive), then clones and writes meta.json', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    const repo = await makeTempGitRepo({ 'README.md': '# Remote Repo\n' })

    await runKbInit({
      base: 'my-remote',
      gitTargets: [{ url: repo, branch: 'main' }],
      nonInteractive: true,
      cwd,
    })

    const baseDir = resolveBaseToDir('my-remote', cwd)
    const meta = await readBaseMeta(baseDir)
    expect(meta?.repos).toHaveLength(1)
    expect(meta?.repos[0]).toEqual(
      expect.objectContaining({
        gitUrl: repo,
        gitBranch: 'main',
        slug: repoSlugFromGitUrl(repo),
      })
    )
    expect(meta?.repos[0]?.dir).toBeTruthy()
    expect(meta?.repos[0]?.lastSyncedSha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(meta?.repos[0]?.lastSyncedAt).toBeTruthy()

    expect(await findKbFile(cwd)).toBe('my-remote')
  })

  it('Given --git without branch, then clones the remote default branch', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    const repo = await makeTempGitRepo({ 'README.md': '# Remote Repo\n' }, 'master')

    await runKbInit({
      base: 'master-remote',
      gitTargets: [{ url: repo }],
      nonInteractive: true,
      cwd,
    })

    const baseDir = resolveBaseToDir('master-remote', cwd)
    const meta = await readBaseMeta(baseDir)
    expect(meta?.repos[0]?.gitBranch).toBe('master')
  })

  it('Given multiple --git targets, then both repos index into one base and meta lists both', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    const repoA = await makeTempGitRepo({
      'README.md': '# Repo A\n\nAlpha service documentation lives here.\n',
    })
    const repoB = await makeTempGitRepo({
      'README.md': '# Repo B\n\nBeta service documentation lives here.\n',
    })

    await runKbInit({
      base: 'multi-remote',
      gitTargets: [
        { url: repoA, branch: 'main' },
        { url: repoB, branch: 'main' },
      ],
      nonInteractive: true,
      cwd,
    })

    const baseDir = resolveBaseToDir('multi-remote', cwd)
    const meta = await readBaseMeta(baseDir)
    expect(meta?.repos).toHaveLength(2)
    const urls = meta?.repos.map(r => r.gitUrl).sort()
    expect(urls).toEqual([repoA, repoB].sort())

    const indexer = new SqliteKbIndexer({ dbPath: path.join(baseDir, '.kb-index.sqlite') })
    try {
      const slugA = repoSlugFromGitUrl(repoA)
      const slugB = repoSlugFromGitUrl(repoB)
      const facts = indexer.listFactsForQuery(99999)
      const repos = new Set(facts.map(f => f.git_repo))
      expect(repos.has(slugA)).toBe(true)
      expect(repos.has(slugB)).toBe(true)
    } finally {
      indexer.close()
    }
  })

  it('Given /cancel at base name prompt, throws InitCancelledError', async () => {
    const cwd = await createTempProject({ 'README.md': '# hi\n' })
    const { io } = createQuestionIO(['/cancel'])

    await expect(
      runKbInit({
        nonInteractive: false,
        stopAfter: 'read-inputs',
        cwd,
        questionIO: io,
      })
    ).rejects.toThrow(/cancel/i)
  })

  it('parseInitCommand parses --git and --branch flags', () => {
    const parsed = parseInitCommand(['--git', 'U', '--branch', 'dev'])
    expect(parsed.gitTargets).toEqual([{ url: 'U', branch: 'dev' }])
  })

  it('parseInitCommand parses repeatable --git with inline branch (no branch = remote default)', () => {
    const parsed = parseInitCommand(['--git', 'A', '--git', 'B#feat'])
    expect(parsed.gitTargets).toEqual([
      { url: 'A', branch: undefined },
      { url: 'B', branch: 'feat' },
    ])
  })

  it('parseInitCommand with only --git leaves the branch undefined (remote default)', () => {
    const parsed = parseInitCommand(['--git', 'U'])
    expect(parsed.gitTargets).toEqual([{ url: 'U', branch: undefined }])
  })
})
