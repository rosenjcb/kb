import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { printConfigHelp, runConfigCommand } from '../../src/cli/config-cli'
import {
  createLLMProviderFromConfig,
  getKbConfigFile,
  listSupportedConfigPaths,
  readKbConfig,
  resolveConversationalChatEnabled,
  resolveLLMProvider,
} from '../../src/cli/kb-config'

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

async function createConfigFile(initial?: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-config-cli-'))
  tempDirs.push(dir)
  const configFile = path.join(dir, 'config.json')
  if (initial !== undefined) {
    await writeFile(configFile, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
  }
  return configFile
}

describe('config-cli', () => {
  it('Given get with no key, then returns normalized full config JSON', async () => {
    const configFile = await createConfigFile({
      defaultBase: 'dogfood',
      notion: { parentPageId: 'abc123' },
      updatedAt: '2026-04-15T00:00:00.000Z',
    })

    const result = await runConfigCommand(['get'], { configFile })

    expect(result.output).toContain('"defaultBase": "dogfood"')
    expect(result.output).toContain('"parentPageId": "abc123"')
  })

  it('Given nested notion key, then get returns scalar and unset prunes empty object', async () => {
    const configFile = await createConfigFile()

    await runConfigCommand(['set', 'notion.parentPageId', 'parent-123'], { configFile })
    const value = await runConfigCommand(['get', 'notion.parentPageId'], { configFile })
    await runConfigCommand(['unset', 'notion.parentPageId'], { configFile })
    const rawAfterUnset = JSON.parse(await readFile(configFile, 'utf8')) as { notion?: unknown }

    expect(value.output).toBe('parent-123\n')
    expect(rawAfterUnset.notion).toBeUndefined()
  })

  it('Given read-only or unknown keys, then returns explicit errors', async () => {
    const configFile = await createConfigFile()

    await expect(runConfigCommand(['set', 'updatedAt', '123'], { configFile })).rejects.toThrow(
      'READ_ONLY_CONFIG_KEY'
    )
    await expect(runConfigCommand(['get', 'foo.bar'], { configFile })).rejects.toThrow(
      'UNKNOWN_CONFIG_KEY'
    )
  })

  it('Given supported but unset key, then get returns explicit not-set error', async () => {
    const configFile = await createConfigFile({})

    await expect(runConfigCommand(['get', 'defaultBase'], { configFile })).rejects.toThrow(
      'UNKNOWN_CONFIG_KEY'
    )
  })

  it('Given KB_HOME override and no explicit config file, then config commands use the overridden home config path', async () => {
    await runConfigCommand(['set', 'notion.parentPageId', 'catalog-root'])

    const saved = await readKbConfig(getKbConfigFile())

    expect(saved.notion?.parentPageId).toBe('catalog-root')
    expect(getKbConfigFile()).toBe(path.join(kbHomeDir, 'config.json'))
  })

  it('Given config help, then it excludes base keys and generated feature keys', () => {
    const help = printConfigHelp()
    expect(help).not.toContain('defaultBase')
    expect(help).not.toContain('defaultBase')
    expect(help).not.toContain('features.')
    expect(help).toContain('notion.parentPageId')
    expect(help).toContain('llm.provider')
  })

  it('Given supported config paths, then they omit base-selection and feature keys', () => {
    const keys = listSupportedConfigPaths()
    expect(keys).not.toContain('defaultBase')
    expect(keys).not.toContain('defaultBase')
    expect(keys).not.toContain('features')
    expect(keys).not.toContain('chat')
    expect(keys).not.toContain('chat.experimentalConversationalRetrieval')
    expect(keys).toContain('notion')
    expect(keys).toContain('llm')
  })

  it('Given internal chat config or env override, then conversational chat flag resolves without becoming a public config key', () => {
    expect(
      resolveConversationalChatEnabled({ chat: { experimentalConversationalRetrieval: true } })
    ).toBe(true)

    process.env.KB_CHAT_CONVERSATIONAL_RETRIEVAL = 'false'
    expect(
      resolveConversationalChatEnabled({ chat: { experimentalConversationalRetrieval: true } })
    ).toBe(false)
    delete process.env.KB_CHAT_CONVERSATIONAL_RETRIEVAL
  })

  it('Given gemini config with a model override, then provider resolution preserves the selected model', () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    try {
      const resolved = resolveLLMProvider({
        llm: {
          provider: 'gemini',
          geminiModel: 'gemini-flash-latest',
        },
      })

      expect(resolved.provider).toBe('gemini')
      expect(resolved.model).toBe('gemini-flash-latest')

      const provider = createLLMProviderFromConfig({
        llm: {
          provider: 'gemini',
          geminiModel: 'gemini-flash-latest',
        },
      })

      expect(provider?.name).toBe('gemini')
    } finally {
      delete process.env.GEMINI_API_KEY
    }
  })
})

describe('config llm subcommand', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.GEMINI_API_KEY
  })

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.GEMINI_API_KEY
  })

  it('Given kb config llm --show with no keys set, then output warns about missing keys', async () => {
    const configFile = await createConfigFile()
    const result = await runConfigCommand(['llm', '--show'], { configFile })
    expect(result.output).toContain('ANTHROPIC_API_KEY')
    expect(result.output).toContain('not set')
  })

  it('Given kb config llm --show with a key set, then output shows it as set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const configFile = await createConfigFile({ llm: { provider: 'anthropic' } })
    const result = await runConfigCommand(['llm', '--show'], { configFile })
    expect(result.output).toContain('ANTHROPIC_API_KEY')
    expect(result.output).toMatch(/✓\s*set/)
  })

  it('Given kb config llm in non-TTY mode, then it falls back to show without prompting', async () => {
    const configFile = await createConfigFile()
    const result = await runConfigCommand(['llm'], { configFile, isTTY: false })
    expect(result.output).toContain('ANTHROPIC_API_KEY')
  })

  it('Given kb config llm --show, then provider from config is displayed', async () => {
    const configFile = await createConfigFile({ llm: { provider: 'gemini' } })
    const result = await runConfigCommand(['llm', '--show'], { configFile })
    expect(result.output).toContain('gemini')
  })
})
