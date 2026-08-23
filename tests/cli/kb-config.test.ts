import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FEATURES,
  LLMKeyMissingError,
  assertLLMKeyAvailable,
  createLLMProviderFromConfig,
  isLLMConfigured,
  listSupportedConfigPaths,
  normalizeKbConfig,
  persistInferredLLMProvider,
  readKbConfig,
  resolveFactRetrievalMethod,
  resolveLLMProvider,
  writeKbConfig,
} from '@kb/core/config/kb-config.js'

let kbHomeDir: string

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-config-test-'))
  process.env.KB_HOME = kbHomeDir
  delete process.env.KB_HOST
  delete process.env.KB_PORT
  delete process.env.KB_SSLMODE
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
  delete process.env.KB_SSLMODE
  delete process.env.KB_LLM_PROVIDER
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.OLLAMA_ENDPOINT
  if (kbHomeDir) await rm(kbHomeDir, { recursive: true, force: true })
})

describe('readKbConfig', () => {
  it('[TC-RFFQ] returns default features when no env is set', async () => {
    const result = await readKbConfig()
    expect(result.features).toMatchObject(DEFAULT_FEATURES)
  })

  it('[TC-ZLRD] reads server profile from KB_HOST/KB_PORT env', async () => {
    process.env.KB_HOST = 'kb.example.com'
    process.env.KB_PORT = '9999'
    const result = await readKbConfig()
    expect(result.server?.host).toBe('kb.example.com')
    expect(result.server?.port).toBe(9999)
  })
})

describe('isLLMConfigured', () => {
  it('[TC-OBQU] returns false when no LLM env vars are set', () => {
    expect(isLLMConfigured()).toBe(false)
  })

  it('[TC-F4WQ] returns true when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    expect(isLLMConfigured()).toBe(true)
  })
})

describe('assertLLMKeyAvailable', () => {
  it('[TC-43MO] throws LLMKeyMissingError for anthropic when ANTHROPIC_API_KEY is not set', () => {
    expect(() => assertLLMKeyAvailable('anthropic')).toThrow(LLMKeyMissingError)
  })

  it('[TC-VBAH] does not throw for ollama (no key required)', () => {
    expect(() => assertLLMKeyAvailable('ollama')).not.toThrow()
  })
})

describe('resolveLLMProvider', () => {
  it('[TC-S6MY] prefers env var when provider is declared', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    const resolved = resolveLLMProvider({ llm: { provider: 'anthropic' } })
    expect(resolved.provider).toBe('anthropic')
    expect(resolved.apiKey).toBe('env-key')
  })

  it('[TC-2OBO] auto-detects provider from env vars when no provider is declared', () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('openai')
  })

  it('[TC-TCBY] falls back to ollama when nothing is configured', () => {
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('ollama')
  })

  it('[TC-7GUG] KB_LLM_PROVIDER env wins over auto-detect', () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    process.env.KB_LLM_PROVIDER = 'gemini'
    process.env.GEMINI_API_KEY = 'gem-key'
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('gemini')
  })
})

describe('persistInferredLLMProvider', () => {
  it('[TC-MA96] returns inferred provider notice when llm.provider is unset and env key exists', async () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    const config = await readKbConfig()
    const result = await persistInferredLLMProvider({ config })
    expect(result.config.llm?.provider).toBe('openai')
    expect(result.notice).toContain('Auto-selected LLM provider: openai')
    expect(result.notice).toContain('KB_LLM_PROVIDER')
  })

  it('[TC-PXZA] does not persist when KB_LLM_PROVIDER is already set', async () => {
    process.env.KB_LLM_PROVIDER = 'gemini'
    process.env.OPENAI_API_KEY = 'openai-env'
    const config = await readKbConfig()
    const result = await persistInferredLLMProvider({ config })
    expect(result.notice).toBeUndefined()
  })
})

describe('listSupportedConfigPaths', () => {
  it('[TC-D2EE] omits base-selection keys', () => {
    const keys = listSupportedConfigPaths()
    expect(keys).not.toContain('defaultBase')
    expect(keys).toContain('server.host')
    expect(keys).toContain('fact_retrieval_method')
  })
})

describe('resolveFactRetrievalMethod', () => {
  it('[TC-RW4A] returns query_expansion by default', () => {
    expect(resolveFactRetrievalMethod({})).toBe('query_expansion')
  })

  it('[TC-DBOL] KB_FACT_RETRIEVAL_METHOD env override wins', () => {
    process.env.KB_FACT_RETRIEVAL_METHOD = 'all_facts'
    expect(resolveFactRetrievalMethod({})).toBe('all_facts')
    delete process.env.KB_FACT_RETRIEVAL_METHOD
  })
})

describe('createLLMProviderFromConfig', () => {
  it('[TC-VV3K] preserves gemini model override', () => {
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
  it('[TC-PNB4] preserves createdAt on round-trip', () => {
    const result = normalizeKbConfig({ createdAt: '2025-01-01T00:00:00.000Z' })
    expect(result.createdAt).toBe('2025-01-01T00:00:00.000Z')
  })
})

describe('writeKbConfig', () => {
  it('[TC-672C] normalizes in memory without writing files', async () => {
    const saved = await writeKbConfig({ llm: { provider: 'openai' } })
    expect(saved.llm?.provider).toBe('openai')
  })
})
