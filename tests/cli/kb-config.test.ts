import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FEATURES,
  LLMKeyMissingError,
  assertLLMKeyAvailable,
  createLLMProviderFromConfig,
  ensureDefaultConfig,
  isLLMConfigured,
  listSupportedConfigPaths,
  normalizeKbConfig,
  readKbConfig,
  resolveFactRetrievalMethod,
  resolveLLMProvider,
  writeDefaultConfig,
  writeKbConfig,
} from '@kb/core/config/kb-config.js'

let kbHomeDir: string

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-config-test-'))
  process.env.KB_HOME = kbHomeDir
  delete process.env.KB_HOST
  delete process.env.KB_PORT
  delete process.env.KB_SERVER_URL
  delete process.env.KB_LLM_PROVIDER
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.OLLAMA_ENDPOINT
})

afterEach(async () => {
  delete process.env.KB_HOME
  delete process.env.KB_HOST
  delete process.env.KB_PORT
  delete process.env.KB_SERVER_URL
  delete process.env.KB_LLM_PROVIDER
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.OLLAMA_ENDPOINT
  if (kbHomeDir) await rm(kbHomeDir, { recursive: true, force: true })
})

describe('readKbConfig', () => {
  it('[TC-296] returns default features when no env is set', async () => {
    const result = await readKbConfig()
    expect(result.features).toMatchObject(DEFAULT_FEATURES)
  })

  it('[TC-297] migrates legacy config.json base fields into line files', async () => {
    await writeFile(
      path.join(kbHomeDir, 'config.json'),
      `${JSON.stringify({ activeBase: 'legacy', defaultBase: 'def' }, null, 2)}\n`,
      'utf8'
    )
    const result = await readKbConfig()
    expect(result.activeBase).toBe('legacy')
    expect(result.defaultBase).toBe('def')
  })

  it('[TC-298] reads server profile from KB_HOST/KB_PORT env', async () => {
    process.env.KB_HOST = 'kb.example.com'
    process.env.KB_PORT = '9999'
    const result = await readKbConfig()
    expect(result.server?.host).toBe('kb.example.com')
    expect(result.server?.port).toBe(9999)
  })
})

describe('writeDefaultConfig', () => {
  it('[TC-299] returns config with default features enabled', async () => {
    const result = await writeDefaultConfig()
    expect(result.features).toMatchObject(DEFAULT_FEATURES)
  })

  it('[TC-300] matches readKbConfig output', async () => {
    const written = await writeDefaultConfig()
    const readBack = await readKbConfig()
    expect(readBack.features?.sqliteIndex).toBe(written.features?.sqliteIndex)
  })
})

describe('ensureDefaultConfig', () => {
  it('[TC-301] returns fresh config with defaults', async () => {
    const result = await ensureDefaultConfig()
    expect(result.features?.sqliteIndex).toBe(true)
  })

  it('[TC-302] picks up NOTION env vars', async () => {
    process.env.NOTION_TOKEN = 'ntn_abc'
    const result = await ensureDefaultConfig()
    expect(result.notion?.token).toBe('ntn_abc')
    delete process.env.NOTION_TOKEN
  })
})

describe('isLLMConfigured', () => {
  it('[TC-303] returns false when no LLM env vars are set', () => {
    expect(isLLMConfigured()).toBe(false)
  })

  it('[TC-304] returns true when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    expect(isLLMConfigured()).toBe(true)
  })
})

describe('assertLLMKeyAvailable', () => {
  it('[TC-305] throws LLMKeyMissingError for anthropic when ANTHROPIC_API_KEY is not set', () => {
    expect(() => assertLLMKeyAvailable('anthropic')).toThrow(LLMKeyMissingError)
  })

  it('[TC-306] does not throw for ollama (no key required)', () => {
    expect(() => assertLLMKeyAvailable('ollama')).not.toThrow()
  })
})

describe('resolveLLMProvider', () => {
  it('[TC-307] prefers env var when provider is declared', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    const resolved = resolveLLMProvider({ llm: { provider: 'anthropic' } })
    expect(resolved.provider).toBe('anthropic')
    expect(resolved.apiKey).toBe('env-key')
  })

  it('[TC-308] auto-detects provider from env vars when no provider is declared', () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('openai')
  })

  it('[TC-309] falls back to ollama when nothing is configured', () => {
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('ollama')
  })

  it('[TC-345b] KB_LLM_PROVIDER env wins over auto-detect', () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    process.env.KB_LLM_PROVIDER = 'gemini'
    process.env.GEMINI_API_KEY = 'gem-key'
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('gemini')
  })
})

describe('listSupportedConfigPaths', () => {
  it('[TC-310] omits base-selection keys', () => {
    const keys = listSupportedConfigPaths()
    expect(keys).not.toContain('defaultBase')
    expect(keys).toContain('server.host')
    expect(keys).toContain('fact_retrieval_method')
  })
})

describe('resolveFactRetrievalMethod', () => {
  it('[TC-311] returns query_expansion by default', () => {
    expect(resolveFactRetrievalMethod({})).toBe('query_expansion')
  })

  it('[TC-312] KB_FACT_RETRIEVAL_METHOD env override wins', () => {
    process.env.KB_FACT_RETRIEVAL_METHOD = 'all_facts'
    expect(resolveFactRetrievalMethod({})).toBe('all_facts')
    delete process.env.KB_FACT_RETRIEVAL_METHOD
  })
})

describe('createLLMProviderFromConfig', () => {
  it('[TC-313] preserves gemini model override', () => {
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

describe('normalizeKbConfig', () => {
  it('[TC-316] preserves createdAt on round-trip', () => {
    const result = normalizeKbConfig({ createdAt: '2025-01-01T00:00:00.000Z' })
    expect(result.createdAt).toBe('2025-01-01T00:00:00.000Z')
  })
})

describe('writeKbConfig', () => {
  it('[TC-317] normalizes in memory without writing files', async () => {
    const saved = await writeKbConfig({ llm: { provider: 'openai' } })
    expect(saved.llm?.provider).toBe('openai')
  })
})
