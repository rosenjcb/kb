import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runLLMSetupWizard, showLLMStatus } from '@kb/client/cli/llm-setup-wizard.js'

function makeInput(lines: string[]): Readable {
  return Readable.from(lines.map(l => `${l}\n`))
}

function createQuestionIO(answers: string[]) {
  const prompts: string[] = []
  return {
    prompts,
    io: {
      async askQuestion(question: string): Promise<string> {
        prompts.push(question)
        const answer = answers.shift()
        if (answer === undefined) {
          throw new Error(`No test answer left for prompt: ${question}`)
        }
        return answer
      },
    },
  }
}

describe('showLLMStatus', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'KB_LLM_PROVIDER']) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it('[TC-365] shows provider from KB_LLM_PROVIDER when set', async () => {
    process.env.KB_LLM_PROVIDER = 'gemini'
    const lines: string[] = []
    await showLLMStatus({ output: msg => lines.push(msg) })
    expect(lines.join('\n')).toContain('gemini')
  })

  it('[TC-366] shows auto-detect when no provider configured', async () => {
    const lines: string[] = []
    await showLLMStatus({ output: msg => lines.push(msg) })
    expect(lines.join('\n')).toContain('(auto-detect)')
  })

  it('[TC-367] shows env var status for each provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const lines: string[] = []
    await showLLMStatus({ output: msg => lines.push(msg) })
    const output = lines.join('\n')
    expect(output).toContain('ANTHROPIC_API_KEY')
    expect(output).toContain('✓ set')
    expect(output).toContain('OPENAI_API_KEY')
    expect(output).toContain('✗ not set')
  })

  it('[TC-368] warns when no LLM key is configured', async () => {
    const lines: string[] = []
    await showLLMStatus({ output: msg => lines.push(msg) })
    expect(lines.join('\n')).toContain('No LLM key is set')
  })
})

describe('runLLMSetupWizard', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    vi.unstubAllEnvs()
  })

  it('[TC-370] prints KB_LLM_PROVIDER hint when user picks anthropic', async () => {
    const lines: string[] = []
    const result = await runLLMSetupWizard({
      output: msg => lines.push(msg),
      input: makeInput(['1']),
    })

    expect(result.provider).toBe('anthropic')
    expect(lines.join('\n')).toContain('KB_LLM_PROVIDER=anthropic')
  })

  it('[TC-373] saves ollama when user picks 4 and marks configured=true', async () => {
    const result = await runLLMSetupWizard({
      output: () => {},
      input: makeInput(['4']),
    })
    expect(result.provider).toBe('ollama')
    expect(result.configured).toBe(true)
  })

  it('[TC-374] configured=false when provider key is absent', async () => {
    const result = await runLLMSetupWizard({
      output: () => {},
      input: makeInput(['1']),
    })
    expect(result.configured).toBe(false)
  })

  it('[TC-378] prints env var export hint when key is missing', async () => {
    const lines: string[] = []
    await runLLMSetupWizard({
      output: msg => lines.push(msg),
      input: makeInput(['1']),
    })
    const output = lines.join('\n')
    expect(output).toContain('ANTHROPIC_API_KEY')
    expect(output).toContain('export ANTHROPIC_API_KEY=')
  })

  it('[TC-380] re-prompts until the user enters a valid provider number', async () => {
    const lines: string[] = []
    const questionIO = createQuestionIO(['9', 'abc', '3'])

    const result = await runLLMSetupWizard({
      output: msg => lines.push(msg),
      questionIO: questionIO.io,
    })

    expect(result.provider).toBe('gemini')
    expect(questionIO.prompts).toHaveLength(3)
    expect(lines.join('\n')).toContain('Please enter a number between 1 and 4.')
  })
})
