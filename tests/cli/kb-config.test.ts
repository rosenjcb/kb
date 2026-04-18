import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FEATURES,
  LLMKeyMissingError,
  assertLLMKeyAvailable,
  ensureDefaultConfig,
  isLLMConfigured,
  normalizeKbConfig,
  persistInferredLLMProvider,
  readKbConfig,
  resolveLLMProvider,
  writeDefaultConfig,
  writeKbConfig,
} from '../../src/cli/kb-config'

const tempDirs: string[] = []
let kbHomeDir: string

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-config-test-'))
  process.env.KB_HOME = kbHomeDir
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.OLLAMA_ENDPOINT
})

afterEach(async () => {
  delete process.env.KB_HOME
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.OLLAMA_ENDPOINT
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
  if (kbHomeDir) await rm(kbHomeDir, { recursive: true, force: true })
})

async function tempConfig(initial?: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-cfg-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'config.json')
  if (initial !== undefined) {
    await writeFile(file, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
  }
  return file
}

// ─── readKbConfig ────────────────────────────────────────────────────────────

describe('readKbConfig', () => {
  it('returns empty object when file does not exist', async () => {
    const result = await readKbConfig('/nonexistent/path/config.json')
    expect(result).toEqual({})
  })

  it('returns empty object when file is malformed JSON', async () => {
    const file = await tempConfig()
    await writeFile(file, 'not json', 'utf8')
    expect(await readKbConfig(file)).toEqual({})
  })

  it('normalizes config on read', async () => {
    const file = await tempConfig({ selectedBase: 'dogfood', llm: { provider: 'gemini' } })
    const result = await readKbConfig(file)
    expect(result.selectedBase).toBe('dogfood')
    expect(result.llm?.provider).toBe('gemini')
  })
})

// ─── writeDefaultConfig ──────────────────────────────────────────────────────

describe('writeDefaultConfig', () => {
  it('writes a config with all default features enabled', async () => {
    const file = await tempConfig()
    const result = await writeDefaultConfig(file)

    expect(result.features).toMatchObject(DEFAULT_FEATURES)
    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()
    expect(result.notion).toBeUndefined()
    expect(result.llm).toBeUndefined()
  })

  it('persists to disk and can be read back', async () => {
    const file = await tempConfig()
    await writeDefaultConfig(file)
    const readBack = await readKbConfig(file)
    expect(readBack.features?.sqliteIndex).toBe(true)
    expect(readBack.features?.hybridQuery).toBe(true)
  })
})

// ─── ensureDefaultConfig ─────────────────────────────────────────────────────

describe('ensureDefaultConfig', () => {
  it('creates fresh config when none exists', async () => {
    const file = path.join(kbHomeDir, 'config.json')
    const result = await ensureDefaultConfig(file)
    expect(result.features?.sqliteIndex).toBe(true)
    expect(result.createdAt).toBeDefined()
  })

  it('merges defaults into existing config without overwriting user values', async () => {
    const file = await tempConfig({
      features: { sqliteIndex: false, hybridQuery: false },
      notion: { token: 'ntn_abc' },
    })
    const result = await ensureDefaultConfig(file)

    // user values are preserved
    expect(result.features?.sqliteIndex).toBe(false)
    expect(result.features?.hybridQuery).toBe(false)
    expect(result.notion?.token).toBe('ntn_abc')
    // missing default keys are filled in
    expect(result.features?.checkpointObservability).toBe(true)
    expect(result.features?.missLearning).toBe(true)
  })

  it('does not overwrite existing createdAt', async () => {
    const file = await tempConfig({ createdAt: '2025-01-01T00:00:00.000Z', features: {} })
    const result = await ensureDefaultConfig(file)
    expect(result.createdAt).toBe('2025-01-01T00:00:00.000Z')
  })
})

// ─── isLLMConfigured ─────────────────────────────────────────────────────────

describe('isLLMConfigured', () => {
  it('returns false when no LLM env vars are set', () => {
    expect(isLLMConfigured()).toBe(false)
  })

  it('returns true when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    expect(isLLMConfigured()).toBe(true)
  })

  it('returns true when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test'
    expect(isLLMConfigured()).toBe(true)
  })

  it('returns true when GEMINI_API_KEY is set', () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    expect(isLLMConfigured()).toBe(true)
  })
})

// ─── assertLLMKeyAvailable ───────────────────────────────────────────────────

describe('assertLLMKeyAvailable', () => {
  it('throws LLMKeyMissingError for anthropic when ANTHROPIC_API_KEY is not set', () => {
    expect(() => assertLLMKeyAvailable('anthropic')).toThrow(LLMKeyMissingError)
    expect(() => assertLLMKeyAvailable('anthropic')).toThrow('ANTHROPIC_API_KEY')
  })

  it('throws LLMKeyMissingError for openai when OPENAI_API_KEY is not set', () => {
    expect(() => assertLLMKeyAvailable('openai')).toThrow(LLMKeyMissingError)
    expect(() => assertLLMKeyAvailable('openai')).toThrow('OPENAI_API_KEY')
  })

  it('throws LLMKeyMissingError for gemini when GEMINI_API_KEY is not set', () => {
    expect(() => assertLLMKeyAvailable('gemini')).toThrow(LLMKeyMissingError)
    expect(() => assertLLMKeyAvailable('gemini')).toThrow('GEMINI_API_KEY')
  })

  it('does not throw for ollama (no key required)', () => {
    expect(() => assertLLMKeyAvailable('ollama')).not.toThrow()
  })

  it('does not throw when the key for the given provider is present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    expect(() => assertLLMKeyAvailable('anthropic')).not.toThrow()
  })

  it('throws generic error with all provider hints when provider is unknown and none configured', () => {
    expect(() => assertLLMKeyAvailable()).toThrow('ANTHROPIC_API_KEY')
    expect(() => assertLLMKeyAvailable()).toThrow('OPENAI_API_KEY')
    expect(() => assertLLMKeyAvailable()).toThrow('GEMINI_API_KEY')
  })

  it('does not throw when called with no provider but a key is in env', () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    expect(() => assertLLMKeyAvailable()).not.toThrow()
  })
})

// ─── resolveLLMProvider ──────────────────────────────────────────────────────

describe('resolveLLMProvider', () => {
  it('prefers env var over config file key when provider is declared', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    const resolved = resolveLLMProvider({
      llm: { provider: 'anthropic' },
    })
    expect(resolved.provider).toBe('anthropic')
    expect(resolved.apiKey).toBe('env-key')
  })

  it('auto-detects provider from env vars when no provider is declared', () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('openai')
    expect(resolved.apiKey).toBe('openai-env')
  })

  it('env var auto-detection prefers anthropic > openai > gemini order', () => {
    process.env.ANTHROPIC_API_KEY = 'ant-key'
    process.env.OPENAI_API_KEY = 'oai-key'
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('anthropic')
  })

  it('preserves geminiModel from config when provider is gemini', () => {
    process.env.GEMINI_API_KEY = 'gem-key'
    const resolved = resolveLLMProvider({
      llm: { provider: 'gemini', geminiModel: 'gemini-flash-latest' },
    })
    expect(resolved.model).toBe('gemini-flash-latest')
  })

  it('falls back to ollama when nothing is configured', () => {
    const resolved = resolveLLMProvider({})
    expect(resolved.provider).toBe('ollama')
  })
})

// ─── persistInferredLLMProvider ───────────────────────────────────────────────

describe('persistInferredLLMProvider', () => {
  it('persists inferred provider when llm.provider is unset and env key exists', async () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    const file = await tempConfig({ features: {} })

    const config = await readKbConfig(file)
    const result = await persistInferredLLMProvider({ config, configFile: file })

    expect(result.config.llm?.provider).toBe('openai')
    expect(result.notice).toContain('Auto-selected LLM provider: openai')

    const readBack = await readKbConfig(file)
    expect(readBack.llm?.provider).toBe('openai')
  })

  it('does not persist when llm.provider is already set', async () => {
    process.env.OPENAI_API_KEY = 'openai-env'
    const file = await tempConfig({ llm: { provider: 'gemini' } })
    const config = await readKbConfig(file)

    const result = await persistInferredLLMProvider({ config, configFile: file })

    expect(result.notice).toBeUndefined()
    expect(result.config.llm?.provider).toBe('gemini')
  })
})

// ─── normalizeKbConfig ───────────────────────────────────────────────────────

describe('normalizeKbConfig', () => {
  it('preserves createdAt on round-trip', () => {
    const result = normalizeKbConfig({ createdAt: '2025-01-01T00:00:00.000Z' })
    expect(result.createdAt).toBe('2025-01-01T00:00:00.000Z')
  })

  it('strips empty llm object', () => {
    const result = normalizeKbConfig({ llm: {} })
    expect(result.llm).toBeUndefined()
  })

  it('strips empty notion object', () => {
    const result = normalizeKbConfig({ notion: { token: '' } })
    expect(result.notion).toBeUndefined()
  })
})

// ─── writeKbConfig ───────────────────────────────────────────────────────────

describe('writeKbConfig', () => {
  it('stamps updatedAt and preserves createdAt', async () => {
    const file = await tempConfig()
    const saved = await writeKbConfig(
      { createdAt: '2025-01-01T00:00:00.000Z', llm: { provider: 'openai' } },
      file
    )
    expect(saved.createdAt).toBe('2025-01-01T00:00:00.000Z')
    expect(saved.updatedAt).toBeDefined()
    expect(saved.llm?.provider).toBe('openai')
  })
})
