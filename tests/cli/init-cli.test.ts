import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LLMCallParams, LLMProvider, LLMResponse } from '../../src/core/types'
import { parseInitCommand, runKbInit } from '../../src/cli/init-cli'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-init-cli-'))
  tempDirs.push(dir)
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      const fullPath = path.join(dir, file)
      await writeFile(fullPath, content, 'utf8')
    }),
  )
  return dir
}

function createQuestionIO(answers: string[]) {
  const prompts: string[] = []
  let index = 0
  return {
    prompts,
    io: {
      write() {},
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
  let index = 0
  let inFlight = false
  return {
    prompts,
    io: {
      write() {},
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
  it('Given detach and resume flags, then parses them into init options', () => {
    const parsed = parseInitCommand([
      '--base',
      'dogfood',
      '--apply',
      '--detach',
      '--resume',
    ])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.apply).toBe(true)
    expect(parsed.detach).toBe(true)
    expect(parsed.resume).toBe(true)
  })

  it('Given interactive read-inputs pause, then persists version 2 checkpoint with interview rounds', async () => {
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
      apply: false,
      dryRun: true,
      nonInteractive: false,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: questionIO.io,
    })

    expect(result.status).toBe('paused')
    expect(result.checkpointFile).toBeTruthy()

    const checkpoint = JSON.parse(await readFile(result.checkpointFile!, 'utf8')) as {
      version: number
      interviewRounds: Array<{ round: number; questions: Array<{ answer?: string }> }>
      context: { userAnswers: Array<{ answer: string }> }
      topicCoverage: Array<{ topic: string }>
    }

    expect(checkpoint.version).toBe(2)
    expect(checkpoint.interviewRounds).toHaveLength(1)
    expect(checkpoint.interviewRounds[0].questions.length).toBeGreaterThan(0)
    expect(checkpoint.context.userAnswers.length).toBe(2)
    expect(checkpoint.topicCoverage.some(topic => topic.topic === 'install-setup')).toBe(true)
  })

  it('Given resumed init after pass1, then asks only follow-up questions and keeps initial round intact', async () => {
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
    const provider = createProvider([
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'architecture',
          tags: ['overview'],
          content: 'Project overview summary with enough detail to satisfy quality gates and explain the system structure.',
        },
      ]),
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'architecture',
          tags: ['overview'],
          content: 'Project overview summary with enough detail to satisfy quality gates and explain the system structure plus refined workflow notes.',
        },
      ]),
    ])

    const firstRun = await runKbInit({
      base: 'dogfood',
      apply: false,
      dryRun: true,
      nonInteractive: false,
      stopAfter: 'pass1',
      cwd,
      questionIO: firstQuestionIO.io,
      provider,
    })

    const followUpQuestionIO = createQuestionIO([
      'Testing uses vitest run.',
      'Deployments happen manually for now.',
      'Configuration uses .env.local.',
      'Biggest gotcha is stale KB facts.',
    ])

    const resumedRun = await runKbInit({
      base: 'dogfood',
      apply: false,
      dryRun: true,
      nonInteractive: false,
      stopAfter: 'pass2',
      cwd,
      resumeFrom: firstRun.checkpointFile,
      questionIO: followUpQuestionIO.io,
      provider,
    })

    expect(resumedRun.status).toBe('paused')
    expect(followUpQuestionIO.prompts.length).toBeGreaterThan(0)
    expect(followUpQuestionIO.prompts.some(prompt => prompt.includes('How do you install or set up this project?'))).toBe(false)

    const checkpoint = JSON.parse(await readFile(firstRun.checkpointFile!, 'utf8')) as {
      interviewRounds: Array<{ round: number; questions: Array<{ question: string; answer?: string }> }>
      completedCycles: string[]
    }

    expect(checkpoint.completedCycles).toContain('pass2')
    expect(checkpoint.interviewRounds.length).toBeGreaterThanOrEqual(1)
    expect(
      checkpoint.interviewRounds.some(round => round.questions.some(question => question.answer)),
    ).toBe(true)
  })

  it('Given version 1 checkpoint, then resume migrates it to version 2 without re-asking old answers', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nSimple overview.\n',
    })
    const checkpointFile = path.join(cwd, '.tmp', 'kb-init', 'dogfood-latest.checkpoint.json')
    await mkdir(path.dirname(checkpointFile), { recursive: true })
    await writeFile(checkpointFile, `${JSON.stringify({
      version: 1,
      updatedAt: '2026-04-15T00:00:00.000Z',
      baseName: 'dogfood',
      workingDir: cwd,
      completedCycles: ['read-inputs'],
      context: {
        sourceFiles: { 'README.md': '# Project\n' },
        userAnswers: [
          { question: 'How do you install or set up this project?', answer: 'Run npm install.' },
        ],
      },
    }, null, 2)}\n`, 'utf8')

    const questionIO = createQuestionIO([])
    const provider = createProvider([
      JSON.stringify([
        {
          title: 'Project Overview',
          type: 'architecture',
          tags: ['overview'],
          content: 'Project overview summary with enough detail to satisfy quality gates and explain the system structure.',
        },
      ]),
    ])

    const result = await runKbInit({
      base: 'dogfood',
      apply: false,
      dryRun: true,
      nonInteractive: true,
      stopAfter: 'pass1',
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

    expect(checkpoint.version).toBe(2)
    expect(checkpoint.interviewRounds[0].questions[0].answer).toBe('Run npm install.')
    expect(checkpoint.completedCycles).toContain('pass1')
  })

  it('Given detach during read-inputs, then checkpoint stores pending questions and resume answers them', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nTiny overview only.\n',
    })

    const detached = await runKbInit({
      base: 'dogfood',
      apply: false,
      dryRun: true,
      nonInteractive: false,
      detach: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: createQuestionIO([]).io,
    })

    expect(detached.status).toBe('paused')

    const pausedCheckpoint = JSON.parse(await readFile(detached.checkpointFile!, 'utf8')) as {
      completedCycles: string[]
      interviewRounds: Array<{ questions: Array<{ answer?: string }> }>
    }

    expect(pausedCheckpoint.completedCycles).not.toContain('read-inputs')
    expect(pausedCheckpoint.interviewRounds[0].questions.some(question => !question.answer)).toBe(true)

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
      apply: false,
      dryRun: true,
      nonInteractive: false,
      resume: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: resumeQuestions.io,
    })

    expect(resumed.status).toBe('paused')

    const resumedCheckpoint = JSON.parse(await readFile(detached.checkpointFile!, 'utf8')) as {
      completedCycles: string[]
      context: { userAnswers: Array<{ answer: string }> }
      interviewRounds: Array<{ questions: Array<{ answer?: string }> }>
    }

    expect(resumedCheckpoint.completedCycles).toContain('read-inputs')
    expect(resumedCheckpoint.context.userAnswers.length).toBeGreaterThan(0)
    expect(resumedCheckpoint.interviewRounds[0].questions.every(question => question.answer)).toBe(true)
  })

  it('Given resumed pending questions, then askQuestion is called sequentially not concurrently', async () => {
    const cwd = await createTempProject({
      'README.md': '# Project\n\nTiny overview only.\n',
    })

    const detached = await runKbInit({
      base: 'dogfood',
      apply: false,
      dryRun: true,
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
      apply: false,
      dryRun: true,
      nonInteractive: false,
      resume: true,
      stopAfter: 'read-inputs',
      cwd,
      questionIO: sequentialQuestionIO.io,
    })

    expect(sequentialQuestionIO.prompts.length).toBeGreaterThan(0)
  })
})
