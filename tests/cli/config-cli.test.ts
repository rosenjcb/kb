import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { printConfigHelp, runConfigCommand } from '@kb/client/cli/config-cli.js'
import {
  createLLMProviderFromConfig,
  listSupportedConfigPaths,
  readKbConfig,
  resolveConversationalChatEnabled,
  resolveFactRetrievalMethod,
  resolveLLMProvider,
} from '@kb/core/config/kb-config.js'

let kbHomeDir: string

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-home-'))
  process.env.KB_HOME = kbHomeDir
})

afterEach(async () => {
  delete process.env.KB_HOME
  delete process.env.KB_FACT_RETRIEVAL_METHOD
  delete process.env.NOTION_PARENT_PAGE_ID
  if (kbHomeDir) {
    await rm(kbHomeDir, { recursive: true, force: true })
  }
})

describe('config-cli', () => {
  it('[TC-131] Given get with no key, then returns normalized full config JSON', async () => {
    process.env.NOTION_PARENT_PAGE_ID = 'abc123'
    await mkdir(path.join(kbHomeDir, 'state'), { recursive: true })
    await writeFile(path.join(kbHomeDir, 'state', 'default-base'), 'dogfood\n', 'utf8')

    const result = await runConfigCommand(['get'])

    expect(result.output).toContain('"defaultBase": "dogfood"')
    expect(result.output).toContain('"parentPageId": "abc123"')
  })

  it('[TC-132] Given set, then throws environment-only error', async () => {
    await expect(runConfigCommand(['set', 'notion.parentPageId', 'parent-123'])).rejects.toThrow(
      'environment-only'
    )
  })

  it('[TC-133] Given read-only or unknown keys, then returns explicit errors', async () => {
    await expect(runConfigCommand(['get', 'foo.bar'])).rejects.toThrow('UNKNOWN_CONFIG_KEY')
  })

  it('[TC-134] Given supported but unset key, then get returns explicit not-set error', async () => {
    await expect(runConfigCommand(['get', 'server.host'])).rejects.toThrow('CONFIG_VALUE_NOT_SET')
  })

  it('[TC-135] Given KB_HOME and env vars, then get reflects env', async () => {
    process.env.KB_HOST = 'remote.example.com'
    const result = await runConfigCommand(['get', 'server.host'])
    expect(result.output).toBe('remote.example.com\n')
  })

  it('[TC-136] Given config help, then it excludes base keys and mentions environment-only', () => {
    const help = printConfigHelp()
    expect(help).not.toContain('defaultBase')
    expect(help).not.toContain('config set')
    expect(help).toContain('environment-only')
    expect(help).toContain('llm.provider')
  })

  it('[TC-137] Given supported config paths, then they omit base-selection keys', () => {
    const keys = listSupportedConfigPaths()
    expect(keys).not.toContain('defaultBase')
    expect(keys).toContain('server.host')
    expect(keys).toContain('fact_retrieval_method')
  })

  it('[TC-138] Given fact_retrieval_method via env, then get returns it', async () => {
    process.env.KB_FACT_RETRIEVAL_METHOD = 'all_facts'
    const value = await runConfigCommand(['get', 'fact_retrieval_method'])
    expect(value.output).toBe('all_facts\n')
  })

  it('[TC-141] Given resolveFactRetrievalMethod, then it returns query_expansion by default', () => {
    expect(resolveFactRetrievalMethod({})).toBe('query_expansion')
  })

  it('[TC-143] Given KB_FACT_RETRIEVAL_METHOD env override, then it wins', () => {
    process.env.KB_FACT_RETRIEVAL_METHOD = 'all_facts'
    expect(resolveFactRetrievalMethod({})).toBe('all_facts')
  })

  it('[TC-145] Given graph.enabled via env, then get returns the flag', async () => {
    process.env.KB_GRAPH = 'false'
    const value = await runConfigCommand(['get', 'graph.enabled'])
    expect(value.output).toBe('false\n')
  })

  it('[TC-147] Given gemini config with a model override, then provider resolution preserves the selected model', () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    try {
      const resolved = resolveLLMProvider({
        llm: { provider: 'gemini', geminiModel: 'gemini-flash-latest' },
      })
      expect(resolved.model).toBe('gemini-flash-latest')
      const provider = createLLMProviderFromConfig({
        llm: { provider: 'gemini', geminiModel: 'gemini-flash-latest' },
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
    delete process.env.KB_LLM_PROVIDER
  })

  it('[TC-148] Given kb config llm --show with no keys set, then output warns about missing keys', async () => {
    const result = await runConfigCommand(['llm', '--show'])
    expect(result.output).toContain('ANTHROPIC_API_KEY')
    expect(result.output).toContain('not set')
  })

  it('[TC-149] Given kb config llm --show with a key set, then output shows it as set', async () => {
    process.env.KB_LLM_PROVIDER = 'anthropic'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    const result = await runConfigCommand(['llm', '--show'])
    expect(result.output).toContain('anthropic')
    expect(result.output).toMatch(/✓/)
  })

  it('[TC-150] Given kb config llm in non-TTY mode, then it falls back to show without prompting', async () => {
    const result = await runConfigCommand(['llm'], { isTTY: false })
    expect(result.output).toContain('ANTHROPIC_API_KEY')
  })
})
