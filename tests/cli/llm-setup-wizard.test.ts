import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readKbConfig } from '../../src/cli/kb-config'
import { runLLMSetupWizard, showLLMStatus } from '../../src/cli/llm-setup-wizard'

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
  let tmpDir: string
  let configFile: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kb-wizard-test-'))
    configFile = path.join(tmpDir, 'config.json')
    await writeFile(configFile, JSON.stringify({}), 'utf-8')
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it('shows provider from config when set', async () => {
    await writeFile(configFile, JSON.stringify({ llm: { provider: 'gemini' } }), 'utf-8')
    const lines: string[] = []
    await showLLMStatus({ configFile, output: msg => lines.push(msg) })
    expect(lines.join('\n')).toContain('gemini')
  })

  it('shows auto-detect when no provider configured', async () => {
    const lines: string[] = []
    await showLLMStatus({ configFile, output: msg => lines.push(msg) })
    expect(lines.join('\n')).toContain('(auto-detect)')
  })

  it('shows env var status for each provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const lines: string[] = []
    await showLLMStatus({ configFile, output: msg => lines.push(msg) })
    const output = lines.join('\n')
    expect(output).toContain('ANTHROPIC_API_KEY')
    expect(output).toContain('✓ set')
    expect(output).toContain('OPENAI_API_KEY')
    expect(output).toContain('✗ not set')
  })

  it('warns when no LLM key is configured', async () => {
    const lines: string[] = []
    await showLLMStatus({ configFile, output: msg => lines.push(msg) })
    expect(lines.join('\n')).toContain('No LLM key is set')
  })

  it('does not warn when a key is set', async () => {
    process.env.GEMINI_API_KEY = 'my-key'
    const lines: string[] = []
    await showLLMStatus({ configFile, output: msg => lines.push(msg) })
    expect(lines.join('\n')).not.toContain('No LLM key is set')
  })
})

describe('runLLMSetupWizard', () => {
  let tmpDir: string
  let configFile: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kb-wizard-test-'))
    configFile = path.join(tmpDir, 'config.json')
    await writeFile(configFile, JSON.stringify({}), 'utf-8')
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    vi.unstubAllEnvs()
  })

  it('saves chosen provider to config when user picks anthropic', async () => {
    const lines: string[] = []
    const result = await runLLMSetupWizard({
      configFile,
      output: msg => lines.push(msg),
      input: makeInput(['1']),
    })

    expect(result.provider).toBe('anthropic')
    const saved = await readKbConfig(configFile)
    expect(saved.llm?.provider).toBe('anthropic')
  })

  it('saves openai when user picks 2', async () => {
    const result = await runLLMSetupWizard({
      configFile,
      output: () => {},
      input: makeInput(['2']),
    })
    expect(result.provider).toBe('openai')
    const saved = await readKbConfig(configFile)
    expect(saved.llm?.provider).toBe('openai')
  })

  it('saves gemini when user picks 3', async () => {
    const result = await runLLMSetupWizard({
      configFile,
      output: () => {},
      input: makeInput(['3']),
    })
    expect(result.provider).toBe('gemini')
  })

  it('saves ollama when user picks 4 and marks configured=true', async () => {
    const result = await runLLMSetupWizard({
      configFile,
      output: () => {},
      input: makeInput(['4']),
    })
    expect(result.provider).toBe('ollama')
    expect(result.configured).toBe(true)
  })

  it('configured=false when provider key is absent', async () => {
    const result = await runLLMSetupWizard({
      configFile,
      output: () => {},
      input: makeInput(['1']),
    })
    expect(result.configured).toBe(false)
  })

  it('configured=true when provider key is present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const result = await runLLMSetupWizard({
      configFile,
      output: () => {},
      input: makeInput(['1']),
    })
    expect(result.configured).toBe(true)
  })

  it('shows all four providers in the menu output', async () => {
    const lines: string[] = []
    await runLLMSetupWizard({
      configFile,
      output: msg => lines.push(msg),
      input: makeInput(['3']),
    })
    const output = lines.join('\n')
    expect(output).toContain('Anthropic Claude')
    expect(output).toContain('OpenAI')
    expect(output).toContain('Google Gemini')
    expect(output).toContain('Ollama')
  })

  it('preserves existing config when writing provider', async () => {
    await writeFile(configFile, JSON.stringify({ notion: { token: 'ntn_123' } }), 'utf-8')
    await runLLMSetupWizard({
      configFile,
      output: () => {},
      input: makeInput(['3']),
    })
    const saved = await readKbConfig(configFile)
    expect(saved.notion?.token).toBe('ntn_123')
    expect(saved.llm?.provider).toBe('gemini')
  })

  it('prints env var export hint when key is missing', async () => {
    const lines: string[] = []
    await runLLMSetupWizard({
      configFile,
      output: msg => lines.push(msg),
      input: makeInput(['1']),
    })
    const output = lines.join('\n')
    expect(output).toContain('ANTHROPIC_API_KEY')
    expect(output).toContain('export ANTHROPIC_API_KEY=')
  })

  it('confirms key is set when present in env', async () => {
    process.env.OPENAI_API_KEY = 'sk-live'
    const lines: string[] = []
    await runLLMSetupWizard({
      configFile,
      output: msg => lines.push(msg),
      input: makeInput(['2']),
    })
    expect(lines.join('\n')).toContain('already set')
  })

  it('re-prompts until the user enters a valid provider number', async () => {
    const lines: string[] = []
    const questionIO = createQuestionIO(['9', 'abc', '3'])

    const result = await runLLMSetupWizard({
      configFile,
      output: msg => lines.push(msg),
      questionIO: questionIO.io,
    })

    expect(result.provider).toBe('gemini')
    expect(questionIO.prompts).toEqual([
      'Enter number (1-4): ',
      'Enter number (1-4): ',
      'Enter number (1-4): ',
    ])
    expect(lines.join('\n')).toContain('Please enter a number between 1 and 4.')
    expect(lines.filter(line => line === 'Please enter a number between 1 and 4.')).toHaveLength(2)
  })
})
