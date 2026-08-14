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
  persistInferredLLMProvider,
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
  it('[TC-272] returns default features when no env is set', async () => {
    const result = await readKbConfig()
    expect(result.features).toMatchObject(DEFAULT_FEATURES)
  })

  it('[TC-273] migrates legacy config.json active base into line files', async () => {
    await writeFile(
      path.join(kbHomeDir, 'config.json'),
      `${JSON.stringify({ activeBase: 'legacy', defaultBase: 'def' }, null, 2)}\n`,
      'utf8'
    )
    const result = await readKbConfig()
    expect(result.activeBase).toBe('legacy')
    // The persistent default base was removed — legacy defaultBase is dropped, not migrated.
    expect(result).not.toHaveProperty('defaultBase')
  })

  it('[TC-274] reads server profile from KB_HOST/KB_PORT env', async () => {
    process.env.KB_HOST = 'kb.example.com'
    process.env.KB_PORT = '9999'
    const result = await readKbConfig()
    expect(result.server?.host).toBe('kb.example.com')
    expect(result.server?.port).toBe(9999)
  })
})

describe('writeDefaultConfig', () => {
  it('[TC-275] returns config with default features enabled', async () => {
    const result = await writeDefaultConfig()
    expect(result.features).toMatchObject(DEFAULT_FEATURES)
  })

  it('[TC-276] matches readKbConfig output', async () => {
    const written = await writeDefaultConfig()
    const readBack = await readKbConfig()
    expect(readBack.features?.sqliteIndex).toBe(written.features?.sqliteIndex)
  })
})

describe('ensureDefaultConfig', () => {
  it('[TC-277] returns fresh config with defaults', async () => {
    const result = await ensureDefaultConfig()
    expect(result.features?.sqliteIndex).toBe(true)
  })

})

describe('isLLMConfigured', () => {
  it('[TC-279] returns false when no LLM env vars are set', () => {
    expect(isLLMConfigured()).toBe(false)
  })

  it('[TC-280] returns true when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    expect(isLLMConfigured()).toBe(true)
  })
})

describe('assertLLMKeyAvailable', () => {
  it('[TC-281] throws LLMKeyMissingError for anthropic when ANTHROPIC_API_KEY is not set', () => {
    expect(() => assertLLMKeyAvailable('anthropic')).toThrow(LLMKeyMissingError)
  })

  it('[TC-282] does not throw for ollama (no key required)', () => {
    expect(() => assertLLMKeyAvailable('ollama')).not.toThrow()
  })
})

describe('resolveLLMProvider', () => {
  it('[TC-283] prefers env var when provider is declared', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    const resolved = resolveLLMProvider({ llm: { provider: 'anthropic' } })
    expect(resolved.provider).toBe('anthropic')
    expect(resolved.apiKey).toBe('env-key')
  })

  it('[TC-284] auto-detects provider from env vars when no provider is declared', () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('openai')
  })

  it('[TC-285] falls back to ollama when nothing is configured', () => {
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('ollama')
  })

  it('[TC-292] KB_LLM_PROVIDER env wins over auto-detect', () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    process.env.KB_LLM_PROVIDER = 'gemini'
    process.env.GEMINI_API_KEY = 'gem-key'
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('gemini')
  })
})

describe('persistInferredLLMProvider', () => {
  it('[TC-290] returns inferred provider notice when llm.provider is unset and env key exists', async () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    const config = await readKbConfig()
    const result = await persistInferredLLMProvider({ config })
    expect(result.config.llm?.provider).toBe('openai')
    expect(result.notice).toContain('Auto-selected LLM provider: openai')
    expect(result.notice).toContain('KB_LLM_PROVIDER')
  })

  it('[TC-291] does not persist when KB_LLM_PROVIDER is already set', async () => {
    process.env.KB_LLM_PROVIDER = 'gemini'
    process.env.OPENAI_API_KEY = 'openai-env'
    const config = await readKbConfig()
    const result = await persistInferredLLMProvider({ config })
    expect(result.notice).toBeUndefined()
  })
})

describe('listSupportedConfigPaths', () => {
  it('[TC-286] omits base-selection keys', () => {
    const keys = listSupportedConfigPaths()
    expect(keys).not.toContain('defaultBase')
    expect(keys).toContain('server.host')
    expect(keys).toContain('fact_retrieval_method')
  })
})

describe('resolveFactRetrievalMethod', () => {
  it('[TC-287] returns query_expansion by default', () => {
    expect(resolveFactRetrievalMethod({})).toBe('query_expansion')
  })

  it('[TC-288] KB_FACT_RETRIEVAL_METHOD env override wins', () => {
    process.env.KB_FACT_RETRIEVAL_METHOD = 'all_facts'
    expect(resolveFactRetrievalMethod({})).toBe('all_facts')
    delete process.env.KB_FACT_RETRIEVAL_METHOD
  })
})

describe('createLLMProviderFromConfig', () => {
  it('[TC-289] preserves gemini model override', () => {
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
  it('[TC-293] preserves createdAt on round-trip', () => {
    const result = normalizeKbConfig({ createdAt: '2025-01-01T00:00:00.000Z' })
    expect(result.createdAt).toBe('2025-01-01T00:00:00.000Z')
  })
})

describe('writeKbConfig', () => {
  it('[TC-294] normalizes in memory without writing files', async () => {
    const saved = await writeKbConfig({ llm: { provider: 'openai' } })
    expect(saved.llm?.provider).toBe('openai')
  })
})
