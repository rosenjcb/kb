import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import dayjs from 'dayjs'
import { createProvider } from '../core/llm-provider'

export type FactRetrievalMethod = 'query_expansion' | 'all_facts'

export interface KbConfig {
  activeBase?: string
  defaultBase?: string
  factRetrievalMethod?: FactRetrievalMethod
  graph?: {
    enabled?: boolean
  }
  chat?: {
    experimentalConversationalRetrieval?: boolean
  }
  notion?: {
    token?: string
    parentPageId?: string
  }
  llm?: {
    /** Explicit provider to use. Auto-detected from env vars when omitted. */
    provider?: 'anthropic' | 'openai' | 'gemini' | 'ollama'
    geminiModel?: string
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
  createdAt?: string
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
  'fact_retrieval_method',
  'graph',
  'graph.enabled',
  'notion',
  'notion.token',
  'notion.parentPageId',
  'llm',
  'llm.provider',
  'llm.geminiModel',
  'llm.ollamaEndpoint',
  'llm.ollamaEmbedModel',
  'llm.openaiModel',
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

export const DEFAULT_FEATURES: Required<NonNullable<KbConfig['features']>> = {
  sqliteIndex: true,
  hybridQuery: true,
  hybridQueryCandidates: 40,
  hybridQueryAlpha: 0.45,
  hybridQueryMaxMs: 120,
  checkpointObservability: true,
  missLearning: true,
  missHints: true,
  missHintMinOccurrences: 3,
  intentLlmAnswer: true,
  laneRouting: true,
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

/**
 * Write a minimum viable config for first-time users.
 * All feature flags are enabled by default; notion/llm keys come from env vars.
 */
export async function writeDefaultConfig(
  configFile: string = getKbConfigFile()
): Promise<KbConfig> {
  const now = dayjs().toISOString()
  const defaults: KbConfig = {
    features: { ...DEFAULT_FEATURES },
    createdAt: now,
    updatedAt: now,
  }
  await mkdir(path.dirname(configFile), { recursive: true })
  await writeFile(configFile, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8')
  return defaults
}

/**
 * Merge default feature flags into an existing config without overwriting user-set values.
 * Preserves all existing config; fills in only missing feature keys.
 */
export async function ensureDefaultConfig(
  configFile: string = getKbConfigFile()
): Promise<KbConfig> {
  const existing = await readKbConfig(configFile)
  const isNew = Object.keys(existing).length === 0

  if (isNew) {
    return writeDefaultConfig(configFile)
  }

  const mergedFeatures: KbConfig['features'] = { ...DEFAULT_FEATURES, ...existing.features }
  const next: KbConfig = { ...existing, features: mergedFeatures }
  if (!existing.createdAt) next.createdAt = existing.updatedAt ?? dayjs().toISOString()

  await writeKbConfig(next, configFile)
  return next
}

/** Returns true if at least one LLM key is present in env (after applyConfigToEnv has run). */
export function isLLMConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.OLLAMA_ENDPOINT
  )
}

/**
 * Throws a human-readable error if the resolved LLM provider has no key available.
 * Call this at the top of any command that requires LLM access.
 */
export function assertLLMKeyAvailable(provider?: string): void {
  const p = provider ?? resolveDetectedProvider()
  switch (p) {
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new LLMKeyMissingError('anthropic', 'ANTHROPIC_API_KEY')
      }
      break
    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        throw new LLMKeyMissingError('openai', 'OPENAI_API_KEY')
      }
      break
    case 'gemini':
      if (!process.env.GEMINI_API_KEY) {
        throw new LLMKeyMissingError('gemini', 'GEMINI_API_KEY')
      }
      break
    case 'ollama':
      break
    default:
      if (!isLLMConfigured()) {
        throw new Error(
          'No LLM provider configured.\n\n' +
            'Set one of the following environment variables and restart kb:\n' +
            '  export ANTHROPIC_API_KEY=<your-key>   # Anthropic Claude\n' +
            '  export OPENAI_API_KEY=<your-key>       # OpenAI\n' +
            '  export GEMINI_API_KEY=<your-key>       # Google Gemini\n\n' +
            'Then run `kb config llm` to set your preferred provider.'
        )
      }
  }
}

function resolveDetectedProvider(): string {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.GEMINI_API_KEY) return 'gemini'
  if (process.env.OLLAMA_ENDPOINT) return 'ollama'
  return 'none'
}

export class LLMKeyMissingError extends Error {
  constructor(provider: string, envVar: string) {
    const providerName =
      provider === 'anthropic'
        ? 'Anthropic Claude'
        : provider === 'openai'
          ? 'OpenAI'
          : provider === 'gemini'
            ? 'Google Gemini'
            : provider
    super(
      `${envVar} is not set.\n\n${providerName} is configured as your LLM provider but the API key is missing.\n\nFix it:\n  export ${envVar}=<your-key>\n\nThen restart kb, or run \`kb config llm\` to switch providers.`
    )
    this.name = 'LLMKeyMissingError'
  }
}

export async function writeKbConfig(
  config: KbConfig,
  configFile: string = getKbConfigFile()
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
    case 'fact_retrieval_method':
      return requireConfigValue(normalized.factRetrievalMethod, keyPath)
    case 'graph':
      return requireConfigValue(normalized.graph, keyPath)
    case 'graph.enabled':
      return requireConfigValue(normalized.graph?.enabled, keyPath)
    case 'notion':
      return requireConfigValue(normalized.notion, keyPath)
    case 'notion.token':
      return requireConfigValue(normalized.notion?.token, keyPath)
    case 'notion.parentPageId':
      return requireConfigValue(normalized.notion?.parentPageId, keyPath)
    case 'llm':
      return requireConfigValue(normalized.llm, keyPath)
    case 'llm.provider':
      return requireConfigValue(normalized.llm?.provider, keyPath)
    case 'llm.geminiModel':
      return requireConfigValue(normalized.llm?.geminiModel, keyPath)
    case 'llm.ollamaEndpoint':
      return requireConfigValue(normalized.llm?.ollamaEndpoint, keyPath)
    case 'llm.ollamaEmbedModel':
      return requireConfigValue(normalized.llm?.ollamaEmbedModel, keyPath)
    case 'llm.openaiModel':
      return requireConfigValue(normalized.llm?.openaiModel, keyPath)
    case 'updatedAt':
      return requireConfigValue(normalized.updatedAt, keyPath)
    default:
      throw new UnknownConfigKeyError(keyPath)
  }
}

export function setConfigValue(config: KbConfig, keyPath: string, value: string): KbConfig {
  assertSupportedConfigPath(keyPath)
  if (keyPath === 'updatedAt') throw new ReadOnlyConfigKeyError(keyPath)

  const next = normalizeKbConfig(config)
  switch (keyPath) {
    case 'fact_retrieval_method':
      if (value !== 'query_expansion' && value !== 'all_facts') {
        throw new Error('fact_retrieval_method must be one of: query_expansion, all_facts')
      }
      next.factRetrievalMethod = value as FactRetrievalMethod
      break
    case 'graph':
      throw new Error('INVALID_CONFIG_WRITE: graph requires a nested key such as graph.enabled')
    case 'graph.enabled':
      next.graph = { ...next.graph, enabled: parseBooleanConfigValue(keyPath, value) }
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
      throw new Error('INVALID_CONFIG_WRITE: llm requires a nested key such as llm.provider')
    case 'llm.provider':
      if (!['anthropic', 'openai', 'gemini', 'ollama'].includes(value)) {
        throw new Error('llm.provider must be one of: anthropic, openai, gemini, ollama')
      }
      next.llm = { ...next.llm, provider: value as NonNullable<KbConfig['llm']>['provider'] }
      break
    case 'llm.geminiModel':
      next.llm = { ...next.llm, geminiModel: value }
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
    case 'fact_retrieval_method':
      next.factRetrievalMethod = undefined
      break
    case 'graph':
      next.graph = undefined
      break
    case 'graph.enabled':
      if (next.graph) next.graph.enabled = undefined
      break
    case 'notion':
      next.notion = undefined
      break
    case 'notion.token':
      if (next.notion) next.notion.token = undefined
      break
    case 'notion.parentPageId':
      if (next.notion) next.notion.parentPageId = undefined
      break
    case 'llm':
      next.llm = undefined
      break
    case 'llm.provider':
      if (next.llm) next.llm.provider = undefined
      break
    case 'llm.geminiModel':
      if (next.llm) next.llm.geminiModel = undefined
      break
    case 'llm.ollamaEndpoint':
      if (next.llm) next.llm.ollamaEndpoint = undefined
      break
    case 'llm.ollamaEmbedModel':
      if (next.llm) next.llm.ollamaEmbedModel = undefined
      break
    case 'llm.openaiModel':
      if (next.llm) next.llm.openaiModel = undefined
      break
    default:
      throw new UnknownConfigKeyError(keyPath)
  }

  return normalizeKbConfig(next)
}

// ─── LLM resolution ───────────────────────────────────────────────────────────

export interface ResolvedLLM {
  provider: 'anthropic' | 'openai' | 'gemini' | 'ollama'
  apiKey?: string
  endpoint?: string
  model?: string
}

/**
 * Resolve which LLM provider and credentials to use.
 * Priority: env vars (primary) → ollama fallback.
 * Explicit config.llm.provider is used as a hint for which env var to prefer.
 */
export function resolveLLMProvider(config: KbConfig): ResolvedLLM {
  const llm = config.llm

  // Explicit provider declared — check its env var first.
  if (llm?.provider) {
    switch (llm.provider) {
      case 'anthropic': {
        const key = process.env.ANTHROPIC_API_KEY
        return { provider: 'anthropic', apiKey: key }
      }
      case 'openai': {
        const key = process.env.OPENAI_API_KEY
        return { provider: 'openai', apiKey: key }
      }
      case 'gemini': {
        const key = process.env.GEMINI_API_KEY
        return { provider: 'gemini', apiKey: key, model: llm.geminiModel }
      }
      case 'ollama':
        return {
          provider: 'ollama',
          endpoint: llm.ollamaEndpoint ?? process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434',
        }
    }
  }

  // Auto-detect from env vars (preferred)
  if (process.env.ANTHROPIC_API_KEY)
    return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY }
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
  if (process.env.GEMINI_API_KEY)
    return { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY, model: llm?.geminiModel }

  return {
    provider: 'ollama',
    endpoint: llm?.ollamaEndpoint ?? process.env.OLLAMA_ENDPOINT ?? 'http://localhost:11434',
  }
}

/**
 * Create an LLM provider instance from config.
 * Returns undefined if provider construction fails (e.g. missing API key).
 */
export function createLLMProviderFromConfig(
  config: KbConfig
): ReturnType<typeof createProvider> | undefined {
  try {
    const { provider, apiKey, endpoint, model } = resolveLLMProvider(config)
    switch (provider) {
      case 'anthropic':
        return createProvider({ provider, apiKey, model })
      case 'openai':
        return createProvider({ provider, apiKey, model })
      case 'gemini':
        return createProvider({ provider, apiKey, model })
      case 'ollama':
        return createProvider({ provider, endpoint: endpoint ?? 'http://localhost:11434', model })
    }
  } catch {
    return undefined
  }
}

export interface PersistedLLMProviderResult {
  config: KbConfig
  notice?: string
}

/**
 * If config.llm.provider is unset but we can infer a provider from environment keys,
 * persist that inferred provider into the config file and return a user-facing notice.
 *
 * This makes implicit provider selection explicit and durable across commands/surfaces.
 */
export async function persistInferredLLMProvider(options: {
  config: KbConfig
  configFile?: string
}): Promise<PersistedLLMProviderResult> {
  const configFile = options.configFile ?? getKbConfigFile()
  const current = options.config.llm?.provider
  if (current) {
    return { config: options.config }
  }

  const inferred = process.env.ANTHROPIC_API_KEY
    ? 'anthropic'
    : process.env.OPENAI_API_KEY
      ? 'openai'
      : process.env.GEMINI_API_KEY
        ? 'gemini'
        : process.env.OLLAMA_ENDPOINT
          ? 'ollama'
          : undefined

  if (!inferred) {
    return { config: options.config }
  }

  const next: KbConfig = {
    ...options.config,
    llm: { ...options.config.llm, provider: inferred },
  }

  const saved = await writeKbConfig(next, configFile)

  const envVar =
    inferred === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : inferred === 'openai'
        ? 'OPENAI_API_KEY'
        : inferred === 'gemini'
          ? 'GEMINI_API_KEY'
          : undefined

  const because = envVar ? ` (detected ${envVar})` : ' (detected OLLAMA_ENDPOINT)'
  return {
    config: saved,
    notice: `ℹ Auto-selected LLM provider: ${inferred}${because}. Saved to ${configFile}.`,
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

export function resolveFactRetrievalMethod(config: KbConfig): FactRetrievalMethod {
  if (process.env.KB_FACT_RETRIEVAL_METHOD === 'all_facts') return 'all_facts'
  if (process.env.KB_FACT_RETRIEVAL_METHOD === 'query_expansion') return 'query_expansion'
  return config.factRetrievalMethod ?? 'query_expansion'
}

export function resolveConversationalChatEnabled(config: KbConfig): boolean {
  if (process.env.KB_CHAT_CONVERSATIONAL_RETRIEVAL !== undefined) {
    return parseBooleanEnv(process.env.KB_CHAT_CONVERSATIONAL_RETRIEVAL, false)
  }

  if (config.chat?.experimentalConversationalRetrieval !== undefined) {
    return config.chat.experimentalConversationalRetrieval
  }

  return false
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
    hybridQueryCandidates:
      f.hybridQueryCandidates ?? parseEnvInt(process.env.KB_HYBRID_QUERY_CANDIDATES, 40),
    hybridQueryAlpha: f.hybridQueryAlpha ?? parseEnvFloat(process.env.KB_HYBRID_QUERY_ALPHA, 0.45),
    hybridQueryMaxMs: f.hybridQueryMaxMs ?? parseEnvInt(process.env.KB_HYBRID_QUERY_MAX_MS, 120),
    checkpointObservability:
      f.checkpointObservability ?? process.env.KB_CHECKPOINT_OBSERVABILITY_ENABLED !== 'false',
    missLearning: f.missLearning ?? process.env.KB_MISS_LEARNING_ENABLED === 'true',
    missHints: f.missHints ?? process.env.KB_MISS_HINTS_ENABLED === 'true',
    missHintMinOccurrences:
      f.missHintMinOccurrences ?? parseEnvInt(process.env.KB_MISS_HINT_MIN_OCCURRENCES, 3),
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
  if (config.graph?.enabled !== undefined && !process.env.KB_GRAPH)
    process.env.KB_GRAPH = String(config.graph.enabled)
  if (
    config.chat?.experimentalConversationalRetrieval !== undefined &&
    !process.env.KB_CHAT_CONVERSATIONAL_RETRIEVAL
  ) {
    process.env.KB_CHAT_CONVERSATIONAL_RETRIEVAL = String(
      config.chat.experimentalConversationalRetrieval
    )
  }

  const llm = config.llm
  if (llm?.geminiModel && !process.env.GEMINI_MODEL) process.env.GEMINI_MODEL = llm.geminiModel
  if (llm?.ollamaEndpoint && !process.env.OLLAMA_ENDPOINT)
    process.env.OLLAMA_ENDPOINT = llm.ollamaEndpoint
  if (llm?.ollamaEmbedModel && !process.env.OLLAMA_EMBED_MODEL)
    process.env.OLLAMA_EMBED_MODEL = llm.ollamaEmbedModel
  if (llm?.openaiModel && !process.env.OPENAI_MODEL) process.env.OPENAI_MODEL = llm.openaiModel

  const f = config.features
  if (f?.sqliteIndex !== undefined && !process.env.KB_SQLITE_INDEX)
    process.env.KB_SQLITE_INDEX = String(f.sqliteIndex)
  if (f?.hybridQuery !== undefined && !process.env.KB_HYBRID_QUERY)
    process.env.KB_HYBRID_QUERY = String(f.hybridQuery)
  if (f?.hybridQueryCandidates !== undefined && !process.env.KB_HYBRID_QUERY_CANDIDATES)
    process.env.KB_HYBRID_QUERY_CANDIDATES = String(f.hybridQueryCandidates)
  if (f?.hybridQueryAlpha !== undefined && !process.env.KB_HYBRID_QUERY_ALPHA)
    process.env.KB_HYBRID_QUERY_ALPHA = String(f.hybridQueryAlpha)
  if (f?.hybridQueryMaxMs !== undefined && !process.env.KB_HYBRID_QUERY_MAX_MS)
    process.env.KB_HYBRID_QUERY_MAX_MS = String(f.hybridQueryMaxMs)
  if (f?.checkpointObservability !== undefined && !process.env.KB_CHECKPOINT_OBSERVABILITY_ENABLED)
    process.env.KB_CHECKPOINT_OBSERVABILITY_ENABLED = String(f.checkpointObservability)
  if (f?.missLearning !== undefined && !process.env.KB_MISS_LEARNING_ENABLED)
    process.env.KB_MISS_LEARNING_ENABLED = String(f.missLearning)
  if (f?.missHints !== undefined && !process.env.KB_MISS_HINTS_ENABLED)
    process.env.KB_MISS_HINTS_ENABLED = String(f.missHints)
  if (f?.laneRouting !== undefined && !process.env.KB_LANE_ROUTING_ENABLED)
    process.env.KB_LANE_ROUTING_ENABLED = String(f.laneRouting)
  if (f?.intentLlmAnswer !== undefined && !process.env.KB_INTENT_LLM_ANSWER)
    process.env.KB_INTENT_LLM_ANSWER = String(f.intentLlmAnswer)
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

  const activeBase =
    typeof input.activeBase === 'string' && input.activeBase.trim()
      ? input.activeBase.trim()
      : undefined
  if (activeBase) {
    normalized.activeBase = activeBase
  }

  const defaultBase =
    typeof input.defaultBase === 'string' && input.defaultBase.trim()
      ? input.defaultBase.trim()
      : undefined

  if (defaultBase) {
    normalized.defaultBase = defaultBase
  }

  if (input.factRetrievalMethod === 'query_expansion' || input.factRetrievalMethod === 'all_facts') {
    normalized.factRetrievalMethod = input.factRetrievalMethod
  }

  if (input.graph && typeof input.graph === 'object' && input.graph.enabled !== undefined) {
    normalized.graph = { enabled: Boolean(input.graph.enabled) }
  }

  if (
    input.chat &&
    typeof input.chat === 'object' &&
    input.chat.experimentalConversationalRetrieval !== undefined
  ) {
    normalized.chat = {
      experimentalConversationalRetrieval: Boolean(input.chat.experimentalConversationalRetrieval),
    }
  }

  const notion = {
    token:
      typeof input.notion?.token === 'string' && input.notion.token.trim()
        ? input.notion.token.trim()
        : undefined,
    parentPageId:
      typeof input.notion?.parentPageId === 'string' && input.notion.parentPageId.trim()
        ? input.notion.parentPageId.trim()
        : undefined,
  }
  if (notion.token || notion.parentPageId) normalized.notion = notion

  if (input.llm && typeof input.llm === 'object') {
    const llm: KbConfig['llm'] = {}
    if (input.llm.provider) llm.provider = input.llm.provider
    if (input.llm.geminiModel?.trim()) llm.geminiModel = input.llm.geminiModel.trim()
    if (input.llm.ollamaEndpoint?.trim()) llm.ollamaEndpoint = input.llm.ollamaEndpoint.trim()
    if (input.llm.ollamaEmbedModel?.trim()) llm.ollamaEmbedModel = input.llm.ollamaEmbedModel.trim()
    if (input.llm.openaiModel?.trim()) llm.openaiModel = input.llm.openaiModel.trim()
    if (Object.keys(llm).length > 0) normalized.llm = llm
  }

  if (input.features && typeof input.features === 'object') {
    const f: KbConfig['features'] = {}
    if (input.features.sqliteIndex !== undefined)
      f.sqliteIndex = Boolean(input.features.sqliteIndex)
    if (input.features.hybridQuery !== undefined)
      f.hybridQuery = Boolean(input.features.hybridQuery)
    if (input.features.hybridQueryCandidates !== undefined)
      f.hybridQueryCandidates = Number(input.features.hybridQueryCandidates)
    if (input.features.hybridQueryAlpha !== undefined)
      f.hybridQueryAlpha = Number(input.features.hybridQueryAlpha)
    if (input.features.hybridQueryMaxMs !== undefined)
      f.hybridQueryMaxMs = Number(input.features.hybridQueryMaxMs)
    if (input.features.checkpointObservability !== undefined)
      f.checkpointObservability = Boolean(input.features.checkpointObservability)
    if (input.features.missLearning !== undefined)
      f.missLearning = Boolean(input.features.missLearning)
    if (input.features.missHints !== undefined) f.missHints = Boolean(input.features.missHints)
    if (input.features.missHintMinOccurrences !== undefined)
      f.missHintMinOccurrences = Number(input.features.missHintMinOccurrences)
    if (input.features.intentLlmAnswer !== undefined)
      f.intentLlmAnswer = Boolean(input.features.intentLlmAnswer)
    if (input.features.laneRouting !== undefined)
      f.laneRouting = Boolean(input.features.laneRouting)
    if (Object.keys(f).length > 0) normalized.features = f
  }

  if (typeof input.createdAt === 'string' && input.createdAt.trim()) {
    normalized.createdAt = input.createdAt
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
  const n = Number.parseInt(value, 10)
  return Number.isNaN(n) ? fallback : n
}

function parseEnvFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseFloat(value)
  return Number.isNaN(n) ? fallback : n
}

function parseBooleanConfigValue(keyPath: string, value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  throw new Error(`${keyPath} must be true or false`)
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return fallback
}
