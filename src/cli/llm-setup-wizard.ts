/**
 * Interactive LLM provider setup wizard.
 *
 * Triggered automatically by `kb init` when no LLM is configured.
 * Replayable via `kb config llm`.
 *
 * The wizard only writes the provider *selection* to config — never the key itself.
 * API keys must be set as environment variables.
 */

import readline from 'node:readline'
import type { KbConfig } from './kb-config'
import { readKbConfig, writeKbConfig, isLLMConfigured, getKbConfigFile } from './kb-config'

export type LLMProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama'

export interface LLMWizardResult {
  provider: LLMProvider
  configured: boolean
}

export interface LLMQuestionIO {
  askQuestion: (question: string) => Promise<string>
  close?: () => void
}

const PROVIDERS: Array<{ id: LLMProvider; label: string; envVar: string }> = [
  { id: 'anthropic', label: 'Anthropic Claude', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { id: 'gemini', label: 'Google Gemini', envVar: 'GEMINI_API_KEY' },
  { id: 'ollama', label: 'Ollama (local, no key needed)', envVar: '' },
]

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

function createReadlineQuestionIO(options: {
  input?: NodeJS.ReadableStream
  outputStream?: NodeJS.WritableStream
}): LLMQuestionIO {
  const rl = readline.createInterface({
    input: options.input ?? process.stdin,
    output: options.outputStream ?? process.stdout,
    terminal: false,
  })

  return {
    askQuestion(question: string) {
      return ask(rl, question)
    },
    close() {
      rl.close()
    },
  }
}

/**
 * Run the interactive LLM setup wizard.
 * Returns the chosen provider and whether a key is now available.
 */
export async function runLLMSetupWizard(options: {
  configFile?: string
  output?: (msg: string) => void
  input?: NodeJS.ReadableStream
  outputStream?: NodeJS.WritableStream
  questionIO?: LLMQuestionIO
} = {}): Promise<LLMWizardResult> {
  const configFile = options.configFile ?? getKbConfigFile()
  const print = options.output ?? ((msg: string) => process.stdout.write(msg + '\n'))
  const questionIO = options.questionIO ?? createReadlineQuestionIO({
    input: options.input,
    outputStream: options.outputStream,
  })

  try {
    print('')
    print('─────────────────────────────────────────')
    print('  KB — LLM Provider Setup')
    print('─────────────────────────────────────────')
    print('')
    print('kb needs an LLM to do its work. Choose your provider:')
    print('')
    PROVIDERS.forEach((p, i) => {
      const keyStatus = p.envVar
        ? (process.env[p.envVar] ? '  ✓ key detected' : '')
        : ''
      print(`  [${i + 1}] ${p.label}${keyStatus}`)
    })
    print('')

    let chosenProvider: typeof PROVIDERS[number] | undefined
    while (!chosenProvider) {
      const raw = await questionIO.askQuestion('Enter number (1-4): ')
      const n = parseInt(raw.trim(), 10)
      if (n >= 1 && n <= PROVIDERS.length) {
        chosenProvider = PROVIDERS[n - 1]
      } else {
        print('Please enter a number between 1 and 4.')
      }
    }

    print('')
    print(`Selected: ${chosenProvider.label}`)

    if (chosenProvider.id === 'ollama') {
      print('')
      print('Ollama runs locally — no API key needed.')
      print('Make sure Ollama is running at http://localhost:11434 (or set OLLAMA_ENDPOINT).')
    } else {
      const envVar = chosenProvider.envVar
      const hasKey = Boolean(process.env[envVar])

      if (hasKey) {
        print(`✓ ${envVar} is already set in your environment.`)
      } else {
        print('')
        print(`You need to set ${envVar} in your shell environment.`)
        print(`Add this to your ~/.zshrc or ~/.bashrc and restart your shell:`)
        print('')
        print(`  export ${envVar}=<your-api-key>`)
        print('')
        print(`Then restart kb. Your provider preference will be saved now.`)
      }
    }

    // Save provider selection to config (not the key)
    const existingConfig = await readKbConfig(configFile)
    const updated: KbConfig = {
      ...existingConfig,
      llm: { ...existingConfig.llm, provider: chosenProvider.id },
    }
    await writeKbConfig(updated, configFile)

    print('')
    print(`✓ Provider saved: ${chosenProvider.id}`)
    print('')

    const configured = chosenProvider.id === 'ollama'
      ? true
      : Boolean(chosenProvider.envVar && process.env[chosenProvider.envVar])

    return { provider: chosenProvider.id, configured }
  } finally {
    questionIO.close?.()
  }
}

/**
 * Non-interactive version: shows status of current LLM config without prompting.
 * Used by `kb config llm --show`.
 */
export async function showLLMStatus(options: {
  configFile?: string
  output?: (msg: string) => void
} = {}): Promise<void> {
  const configFile = options.configFile ?? getKbConfigFile()
  const print = options.output ?? ((msg: string) => process.stdout.write(msg + '\n'))
  const config = await readKbConfig(configFile)

  print('')
  print('LLM Configuration')
  print('─────────────────')

  const provider = config.llm?.provider ?? '(auto-detect)'
  print(`Provider:  ${provider}`)
  print('')
  print('Environment variables:')
  for (const p of PROVIDERS) {
    if (!p.envVar) continue
    const set = Boolean(process.env[p.envVar])
    print(`  ${p.envVar.padEnd(20)} ${set ? '✓ set' : '✗ not set'}`)
  }

  if (!isLLMConfigured()) {
    print('')
    print('⚠ No LLM key is set. Run `kb config llm` to configure.')
  }
  print('')
}
