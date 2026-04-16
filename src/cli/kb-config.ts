import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import dayjs from 'dayjs'
import { createProvider } from '../core/llm-provider'

export interface KbConfig {
  selectedBase?: string
  defaultBase?: string
  sessionBase?: string
  notion?: {
    token?: string
    parentPageId?: string
  }
  llm?: {
    /** Explicit provider to use. If omitted, auto-detected from whichever key is present. */
    provider?: 'anthropic' | 'openai' | 'gemini' | 'ollama'
    anthropicApiKey?: string
    openaiApiKey?: string
    geminiApiKey?: string
    ollamaEndpoint?: string
    ollamaEmbedModel?: string
    openaiModel?: string
  }
  features?: {
    sqliteIndex?: boolean
    hybridQuery?: boolean
    hybridQueryCandidates?: number
    hybridQueryAlpha?: number
    hybridQueryMaxMs?: number
    checkpointObservability?: boolean
    missLearning?: boolean
    missHints?: boolean
    missHintMinOccurrences?: number
    intentLlmAnswer?: boolean
    laneRouting?: boolean
  }
  updatedAt?: string
}

export function getKbConfigDir(): string {
  const override = process.env.KB_HOME?.trim()
  return override ? path.resolve(override) : path.join(os.homedir(), '.kb')
}

export function getKbConfigFile(): string {
  return path.join(getKbConfigDir(), 'config.json')
}

export const KB_CONFIG_DIR = getKbConfigDir()
export const KB_CONFIG_FILE = getKbConfigFile()

const SUPPORTED_CONFIG_PATHS = [
  'selectedBase',
  'defaultBase',
  'notion',
  'notion.token',
  'notion.parentPageId',
  'llm',
  'llm.provider',
  'llm.anthropicApiKey',
  'llm.openaiApiKey',
  'llm.geminiApiKey',
  'llm.ollamaEndpoint',
  'llm.ollamaEmbedModel',
  'llm.openaiModel',
  'features',
  'features.sqliteIndex',
  'features.hybridQuery',
  'features.hybridQueryCandidates',
  'features.hybridQueryAlpha',
  'features.hybridQueryMaxMs',
  'features.checkpointObservability',
  'features.missLearning',
  'features.missHints',
  'features.laneRouting',
  'features.intentLlmAnswer',
  'updatedAt',
] as const

export type SupportedConfigPath = (typeof SUPPORTED_CONFIG_PATHS)[number]

export class UnknownConfigKeyError extends Error {
  constructor(keyPath: string) {
    super(`UNKNOWN_CONFIG_KEY: ${keyPath}. Supported keys: ${SUPPORTED_CONFIG_PATHS.join(', ')}`)
  }
}

export class ReadOnlyConfigKeyError extends Error {
  constructor(keyPath: string) {
    super(`READ_ONLY_CONFIG_KEY: ${keyPath} is managed automatically`)
  }
}

export class ConfigValueNotSetError extends Error {
  constructor(keyPath: string) {
    super(`CONFIG_VALUE_NOT_SET: ${keyPath}`)
  }
}

export async function readKbConfig(configFile: string = getKbConfigFile()): Promise<KbConfig> {
  try {
    const raw = await readFile(configFile, 'utf8')
    const parsed = JSON.parse(raw) as KbConfig
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    return normalizeKbConfig(parsed)
  } catch {
    return {}
  }
}

export async function writeKbConfig(
  config: KbConfig,
  configFile: string = getKbConfigFile(),
): Promise<KbConfig> {
  const normalized = normalizeKbConfig({
    ...config,
    updatedAt: dayjs().toISOString(),
  })

  await mkdir(path.dirname(configFile), { recursive: true })
  await writeFile(configFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

export function listSupportedConfigPaths(): readonly SupportedConfigPath[] {
  return SUPPORTED_CONFIG_PATHS
}

export function getConfigValue(config: KbConfig, keyPath?: string): unknown {
  if (!keyPath) {
    return normalizeKbConfig(config)
  }

  assertSupportedConfigPath(keyPath)
  const normalized = normalizeKbConfig(config)

  switch (keyPath) {
    case 'selectedBase': return requireConfigValue(normalized.selectedBase, keyPath)
    case 'defaultBase': return requireConfigValue(normalized.selectedBase, keyPath)
    case 'notion': return requireConfigValue(normalized.notion, keyPath)
    case 'notion.token': return requireConfigValue(normalized.notion?.token, keyPath)
    case 'notion.parentPageId': return requireConfigValue(normalized.notion?.parentPageId, keyPath)
    case 'llm': return requireConfigValue(normalized.llm, keyPath)
    case 'llm.provider': return requireConfigValue(normalized.llm?.provider, keyPath)
    case 'llm.anthropicApiKey': return requireConfigValue(normalized.llm?.anthropicApiKey, keyPath)
    case 'llm.openaiApiKey': return requireConfigValue(normalized.llm?.openaiApiKey, keyPath)
    case 'llm.geminiApiKey': return requireConfigValue(normalized.llm?.geminiApiKey, keyPath)
    case 'llm.ollamaEndpoint': return requireConfigValue(normalized.llm?.ollamaEndpoint, keyPath)
    case 'llm.ollamaEmbedModel': return requireConfigValue(normalized.llm?.ollamaEmbedModel, keyPath)
    case 'llm.openaiModel': return requireConfigValue(normalized.llm?.openaiModel, keyPath)
    case 'features': return requireConfigValue(normalized.features, keyPath)
    case 'features.sqliteIndex': return requireConfigValue(normalized.features?.sqliteIndex, keyPath)
    case 'features.hybridQuery': return requireConfigValue(normalized.features?.hybridQuery, keyPath)
    case 'features.hybridQueryCandidates': return requireConfigValue(normalized.features?.hybridQueryCandidates, keyPath)
    case 'features.hybridQueryAlpha': return requireConfigValue(normalized.features?.hybridQueryAlpha, keyPath)
    case 'features.hybridQueryMaxMs': return requireConfigValue(normalized.features?.hybridQueryMaxMs, keyPath)
    case 'features.checkpointObservability': return requireConfigValue(normalized.features?.checkpointObservability, keyPath)
    case 'features.missLearning': return requireConfigValue(normalized.features?.missLearning, keyPath)
    case 'features.missHints': return requireConfigValue(normalized.features?.missHints, keyPath)
    case 'features.laneRouting': return requireConfigValue(normalized.features?.laneRouting, keyPath)
    case 'features.intentLlmAnswer': return requireConfigValue(normalized.features?.intentLlmAnswer, keyPath)
    case 'updatedAt': return requireConfigValue(normalized.updatedAt, keyPath)
    default: throw new UnknownConfigKeyError(keyPath)
  }
}

export function setConfigValue(config: KbConfig, keyPath: string, value: string): KbConfig {
  assertSupportedConfigPath(keyPath)
  if (keyPath === 'updatedAt') throw new ReadOnlyConfigKeyError(keyPath)

  const next = normalizeKbConfig(config)
  switch (keyPath) {
    case 'selectedBase':
      next.selectedBase = value
      break
    case 'defaultBase':
      next.selectedBase = value
      break
    case 'notion':
      throw new Error('INVALID_CONFIG_WRITE: notion requires a nested key such as notion.token')
    case 'notion.token':
      next.notion = { ...next.notion, token: value }
      break
    case 'notion.parentPageId':
      next.notion = { ...next.notion, parentPageId: value }
      break
    case 'llm':
      throw new Error('INVALID_CONFIG_WRITE: llm requires a nested key such as llm.openaiApiKey')
    case 'llm.provider':
      if (!['anthropic', 'openai', 'gemini', 'ollama'].includes(value)) {
        throw new Error('llm.provider must be one of: anthropic, openai, gemini, ollama')
      }
      next.llm = { ...next.llm, provider: value as NonNullable<KbConfig['llm']>['provider'] }
      break
    case 'llm.anthropicApiKey':
      next.llm = { ...next.llm, anthropicApiKey: value }
      break
    case 'llm.openaiApiKey':
      next.llm = { ...next.llm, openaiApiKey: value }
      break
    case 'llm.geminiApiKey':
      next.llm = { ...next.llm, geminiApiKey: value }
      break
    case 'llm.ollamaEndpoint':
      next.llm = { ...next.llm, ollamaEndpoint: value }
      break
    case 'llm.ollamaEmbedModel':
      next.llm = { ...next.llm, ollamaEmbedModel: value }
      break
    case 'llm.openaiModel':
      next.llm = { ...next.llm, openaiModel: value }
      break
    case 'features':
      throw new Error('INVALID_CONFIG_WRITE: features requires a nested key such as features.hybridQuery')
    case 'features.sqliteIndex':
      next.features = { ...next.features, sqliteIndex: value === 'true' }
      break
    case 'features.hybridQuery':
      next.features = { ...next.features, hybridQuery: value === 'true' }
      break
    case 'features.hybridQueryCandidates':
      next.features = { ...next.features, hybridQueryCandidates: Number(value) }
      break
    case 'features.hybridQueryAlpha':
      next.features = { ...next.features, hybridQueryAlpha: Number(value) }
      break
    case 'features.hybridQueryMaxMs':
      next.features = { ...next.features, hybridQueryMaxMs: Number(value) }
      break
    case 'features.checkpointObservability':
      next.features = { ...next.features, checkpointObservability: value === 'true' }
      break
    case 'features.missLearning':
      next.features = { ...next.features, missLearning: value === 'true' }
      break
    case 'features.missHints':
      next.features = { ...next.features, missHints: value === 'true' }
      break
    case 'features.laneRouting':
      next.features = { ...next.features, laneRouting: value === 'true' }
      break
    case 'features.intentLlmAnswer':
      next.features = { ...next.features, intentLlmAnswer: value === 'true' }
      break
    default:
      throw new UnknownConfigKeyError(keyPath)
  }

  return normalizeKbConfig(next)
}

export function unsetConfigValue(config: KbConfig, keyPath: string): KbConfig {
  assertSupportedConfigPath(keyPath)
  if (keyPath === 'updatedAt') throw new ReadOnlyConfigKeyError(keyPath)

  const next = normalizeKbConfig(config)
  switch (keyPath) {
    case 'selectedBase': delete next.selectedBase; break
    case 'defaultBase': delete next.selectedBase; break
    case 'notion': delete next.notion; break
    case 'notion.token': if (next.notion) delete next.notion.token; break
    case 'notion.parentPageId': if (next.notion) delete next.notion.parentPageId; break
    case 'llm': delete next.llm; break
    case 'llm.provider': if (next.llm) delete next.llm.provider; break
    case 'llm.anthropicApiKey': if (next.llm) delete next.llm.anthropicApiKey; break
    case 'llm.openaiApiKey': if (next.llm) delete next.llm.openaiApiKey; break
    case 'llm.geminiApiKey': if (next.llm) delete next.llm.geminiApiKey; break
    case 'llm.ollamaEndpoint': if (next.llm) delete next.llm.ollamaEndpoint; break
    case 'llm.ollamaEmbedModel': if (next.llm) delete next.llm.ollamaEmbedModel; break
    case 'llm.openaiModel': if (next.llm) delete next.llm.openaiModel; break
    case 'features': delete next.features; break
    case 'features.sqliteIndex': if (next.features) delete next.features.sqliteIndex; break
    case 'features.hybridQuery': if (next.features) delete next.features.hybridQuery; break
    case 'features.hybridQueryCandidates': if (next.features) delete next.features.hybridQueryCandidates; break
    case 'features.hybridQueryAlpha': if (next.features) delete next.features.hybridQueryAlpha; break
    case 'features.hybridQueryMaxMs': if (next.features) delete next.features.hybridQueryMaxMs; break
    case 'features.checkpointObservability': if (next.features) delete next.features.checkpointObservability; break
    case 'features.missLearning': if (next.features) delete next.features.missLearning; break
    case 'features.missHints': if (next.features) delete next.features.missHints; break
    case 'features.laneRouting': if (next.features) delete next.features.laneRouting; break
    case 'features.intentLlmAnswer': if (next.features) delete next.features.intentLlmAnswer; break
    default: throw new UnknownConfigKeyError(keyPath)
  }

  return normalizeKbConfig(next)
}

// ─── LLM resolution ───────────────────────────────────────────────────────────

export interface ResolvedLLM {
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  apiKey?: string
  endpoint?: string
}

/**
 * Resolve which LLM provider and credentials to use.
 * Priority: explicit config.llm.provider → auto-detect from key presence → env var fallback → ollama.
 */
export function resolveLLMProvider(config: KbConfig): ResolvedLLM {
  const llm = config.llm

  // Explicit provider declared — use its matching key
  if (llm?.provider) {
    switch (llm.provider) {
      case 'anthropic': return { provider: 'anthropic', apiKey: llm.anthropicApiKey }
      case 'openai': return { provider: 'openai', apiKey: llm.openaiApiKey }
      case 'gemini': return { provider: 'gemini', apiKey: llm.geminiApiKey }
      case 'ollama': return { provider: 'ollama', endpoint: llm.ollamaEndpoint ?? 'http://localhost:11434' }
    }
  }

  // Auto-detect from whichever key is present in config
  if (llm?.anthropicApiKey) return { provider: 'anthropic', apiKey: llm.anthropicApiKey }
  if (llm?.openaiApiKey) return { provider: 'openai', apiKey: llm.openaiApiKey }
  if (llm?.geminiApiKey) return { provider: 'gemini', apiKey: llm.geminiApiKey }

  // Env var fallback (legacy / CI override)
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY }

  return { provider: 'ollama', endpoint: llm?.ollamaEndpoint ?? process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434' }
}

/**
 * Create an LLM provider instance from config.
 * Returns undefined if provider construction fails (e.g. missing API key).
 */
export function createLLMProviderFromConfig(config: KbConfig): ReturnType<typeof createProvider> | undefined {
  try {
    const { provider, apiKey, endpoint } = resolveLLMProvider(config)
    switch (provider) {
      case 'anthropic': return createProvider({ provider, apiKey })
      case 'openai': return createProvider({ provider, apiKey })
      case 'gemini': return createProvider({ provider, apiKey })
      case 'ollama': return createProvider({ provider, endpoint: endpoint ?? 'http://localhost:11434' })
    }
  } catch {
    return undefined
  }
}

// ─── Feature flags ────────────────────────────────────────────────────────────

export interface ResolvedFeatureFlags {
  sqliteIndex: boolean
  hybridQuery: boolean
  hybridQueryCandidates: number
  hybridQueryAlpha: number
  hybridQueryMaxMs: number
  checkpointObservability: boolean
  missLearning: boolean
  missHints: boolean
  missHintMinOccurrences: number
  intentLlmAnswer: boolean
  laneRouting: boolean
}

/**
 * Resolve feature flags from config, falling back to env vars for any unset flags.
 * Config values always win over env vars.
 */
export function resolveFeatureFlags(config: KbConfig): ResolvedFeatureFlags {
  const f = config.features ?? {}
  return {
    sqliteIndex: f.sqliteIndex ?? process.env.KB_SQLITE_INDEX === 'true',
    hybridQuery: f.hybridQuery ?? process.env.KB_HYBRID_QUERY === 'true',
    hybridQueryCandidates: f.hybridQueryCandidates ?? parseEnvInt(process.env.KB_HYBRID_QUERY_CANDIDATES, 40),
    hybridQueryAlpha: f.hybridQueryAlpha ?? parseEnvFloat(process.env.KB_HYBRID_QUERY_ALPHA, 0.45),
    hybridQueryMaxMs: f.hybridQueryMaxMs ?? parseEnvInt(process.env.KB_HYBRID_QUERY_MAX_MS, 120),
    checkpointObservability: f.checkpointObservability ?? process.env.KB_CHECKPOINT_OBSERVABILITY_ENABLED !== 'false',
    missLearning: f.missLearning ?? process.env.KB_MISS_LEARNING_ENABLED === 'true',
    missHints: f.missHints ?? process.env.KB_MISS_HINTS_ENABLED === 'true',
    missHintMinOccurrences: f.missHintMinOccurrences ?? parseEnvInt(process.env.KB_MISS_HINT_MIN_OCCURRENCES, 3),
    intentLlmAnswer: f.intentLlmAnswer ?? process.env.KB_INTENT_LLM_ANSWER !== 'false',
    laneRouting: f.laneRouting ?? process.env.KB_LANE_ROUTING_ENABLED !== 'false',
  }
}

/**
 * Apply config values to process.env so internal code that still reads env vars
 * directly (e.g. embedding helpers, sqlite model selection) picks them up.
 * Config values only override env vars that are not already set.
 */
export function applyConfigToEnv(config: KbConfig): void {
  const llm = config.llm
  if (llm?.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = llm.anthropicApiKey
  if (llm?.openaiApiKey && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = llm.openaiApiKey
  if (llm?.geminiApiKey && !process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = llm.geminiApiKey
  if (llm?.ollamaEndpoint && !process.env.OLLAMA_ENDPOINT) process.env.OLLAMA_ENDPOINT = llm.ollamaEndpoint
  if (llm?.ollamaEmbedModel && !process.env.OLLAMA_EMBED_MODEL) process.env.OLLAMA_EMBED_MODEL = llm.ollamaEmbedModel
  if (llm?.openaiModel && !process.env.OPENAI_MODEL) process.env.OPENAI_MODEL = llm.openaiModel

  const f = config.features
  if (f?.sqliteIndex !== undefined && !process.env.KB_SQLITE_INDEX) process.env.KB_SQLITE_INDEX = String(f.sqliteIndex)
  if (f?.hybridQuery !== undefined && !process.env.KB_HYBRID_QUERY) process.env.KB_HYBRID_QUERY = String(f.hybridQuery)
  if (f?.hybridQueryCandidates !== undefined && !process.env.KB_HYBRID_QUERY_CANDIDATES) process.env.KB_HYBRID_QUERY_CANDIDATES = String(f.hybridQueryCandidates)
  if (f?.hybridQueryAlpha !== undefined && !process.env.KB_HYBRID_QUERY_ALPHA) process.env.KB_HYBRID_QUERY_ALPHA = String(f.hybridQueryAlpha)
  if (f?.hybridQueryMaxMs !== undefined && !process.env.KB_HYBRID_QUERY_MAX_MS) process.env.KB_HYBRID_QUERY_MAX_MS = String(f.hybridQueryMaxMs)
  if (f?.checkpointObservability !== undefined && !process.env.KB_CHECKPOINT_OBSERVABILITY_ENABLED) process.env.KB_CHECKPOINT_OBSERVABILITY_ENABLED = String(f.checkpointObservability)
  if (f?.missLearning !== undefined && !process.env.KB_MISS_LEARNING_ENABLED) process.env.KB_MISS_LEARNING_ENABLED = String(f.missLearning)
  if (f?.missHints !== undefined && !process.env.KB_MISS_HINTS_ENABLED) process.env.KB_MISS_HINTS_ENABLED = String(f.missHints)
  if (f?.laneRouting !== undefined && !process.env.KB_LANE_ROUTING_ENABLED) process.env.KB_LANE_ROUTING_ENABLED = String(f.laneRouting)
  if (f?.intentLlmAnswer !== undefined && !process.env.KB_INTENT_LLM_ANSWER) process.env.KB_INTENT_LLM_ANSWER = String(f.intentLlmAnswer)
}

// ─── Notion ───────────────────────────────────────────────────────────────────

export function resolveNotionToken(config: KbConfig): string | undefined {
  return (
    config.notion?.token?.trim() ||
    process.env.NOTION_TOKEN?.trim() ||
    process.env.NOTION_API_KEY?.trim()
  )
}

// ─── Normalization ────────────────────────────────────────────────────────────

export function normalizeKbConfig(input: KbConfig): KbConfig {
  const normalized: KbConfig = {}

  const selectedBase = typeof input.selectedBase === 'string' && input.selectedBase.trim()
    ? input.selectedBase.trim()
    : typeof input.sessionBase === 'string' && input.sessionBase.trim()
      ? input.sessionBase.trim()
      : typeof input.defaultBase === 'string' && input.defaultBase.trim()
        ? input.defaultBase.trim()
        : undefined

  if (selectedBase) {
    normalized.selectedBase = selectedBase
  }

  const notion = {
    token: typeof input.notion?.token === 'string' && input.notion.token.trim()
      ? input.notion.token.trim()
      : undefined,
    parentPageId: typeof input.notion?.parentPageId === 'string' && input.notion.parentPageId.trim()
      ? input.notion.parentPageId.trim()
      : undefined,
  }
  if (notion.token || notion.parentPageId) normalized.notion = notion

  if (input.llm && typeof input.llm === 'object') {
    const llm: KbConfig['llm'] = {}
    if (input.llm.provider) llm.provider = input.llm.provider
    if (input.llm.anthropicApiKey?.trim()) llm.anthropicApiKey = input.llm.anthropicApiKey.trim()
    if (input.llm.openaiApiKey?.trim()) llm.openaiApiKey = input.llm.openaiApiKey.trim()
    if (input.llm.geminiApiKey?.trim()) llm.geminiApiKey = input.llm.geminiApiKey.trim()
    if (input.llm.ollamaEndpoint?.trim()) llm.ollamaEndpoint = input.llm.ollamaEndpoint.trim()
    if (input.llm.ollamaEmbedModel?.trim()) llm.ollamaEmbedModel = input.llm.ollamaEmbedModel.trim()
    if (input.llm.openaiModel?.trim()) llm.openaiModel = input.llm.openaiModel.trim()
    if (Object.keys(llm).length > 0) normalized.llm = llm
  }

  if (input.features && typeof input.features === 'object') {
    const f: KbConfig['features'] = {}
    if (input.features.sqliteIndex !== undefined) f.sqliteIndex = Boolean(input.features.sqliteIndex)
    if (input.features.hybridQuery !== undefined) f.hybridQuery = Boolean(input.features.hybridQuery)
    if (input.features.hybridQueryCandidates !== undefined) f.hybridQueryCandidates = Number(input.features.hybridQueryCandidates)
    if (input.features.hybridQueryAlpha !== undefined) f.hybridQueryAlpha = Number(input.features.hybridQueryAlpha)
    if (input.features.hybridQueryMaxMs !== undefined) f.hybridQueryMaxMs = Number(input.features.hybridQueryMaxMs)
    if (input.features.checkpointObservability !== undefined) f.checkpointObservability = Boolean(input.features.checkpointObservability)
    if (input.features.missLearning !== undefined) f.missLearning = Boolean(input.features.missLearning)
    if (input.features.missHints !== undefined) f.missHints = Boolean(input.features.missHints)
    if (input.features.missHintMinOccurrences !== undefined) f.missHintMinOccurrences = Number(input.features.missHintMinOccurrences)
    if (input.features.intentLlmAnswer !== undefined) f.intentLlmAnswer = Boolean(input.features.intentLlmAnswer)
    if (input.features.laneRouting !== undefined) f.laneRouting = Boolean(input.features.laneRouting)
    if (Object.keys(f).length > 0) normalized.features = f
  }

  if (typeof input.updatedAt === 'string' && input.updatedAt.trim()) {
    normalized.updatedAt = input.updatedAt
  }

  return normalized
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertSupportedConfigPath(keyPath: string): asserts keyPath is SupportedConfigPath {
  if (!(SUPPORTED_CONFIG_PATHS as readonly string[]).includes(keyPath)) {
    throw new UnknownConfigKeyError(keyPath)
  }
}

function requireConfigValue<T>(value: T | undefined, keyPath: string): T {
  if (value === undefined) throw new ConfigValueNotSetError(keyPath)
  return value
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = parseInt(value, 10)
  return Number.isNaN(n) ? fallback : n
}

function parseEnvFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = parseFloat(value)
  return Number.isNaN(n) ? fallback : n
}
