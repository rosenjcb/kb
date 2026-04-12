/**
 * Configuration loader and validator
 * Loads environment at startup, validates, fails fast on errors
 * See: Ticket 006 - Environment Loading Policy
 */

import { z } from 'zod'

const ConfigSchema = z.object({
  // LLM Provider (required)
  llmProvider: z.enum(['anthropic', 'openai', 'gemini', 'ollama']),

  // API Keys (required per provider)
  anthropicApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  ollamaEndpoint: z.string().url().optional().default('http://localhost:11434'),

  // KB Storage
  kbBaseDir: z.string().default('./sessions/namespaces/default/documents'),

  // Agent Loop Tuning
  maxAgentTurns: z.number().int().min(1).default(10),
  agentTimeoutMs: z.number().int().min(1000).default(300000),
  toolTimeoutMs: z.number().int().min(1000).default(30000),

  // Observability
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Feature Flags
  enableSemanticSearch: z.boolean().default(false),
  enableNotionBackend: z.boolean().default(false),

  // Environment
  environment: z.enum(['development', 'staging', 'production']).default('development'),
  nodeEnv: z.enum(['development', 'production', 'test']).optional(),
})

export type Config = z.infer<typeof ConfigSchema>

/**
 * Loads configuration from environment variables.
 * Fails fast if validation fails.
 */
export function loadConfig(): Config {
  const raw = {
    llmProvider: process.env.LLM_PROVIDER,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    ollamaEndpoint: process.env.OLLAMA_ENDPOINT,
    kbBaseDir: process.env.KB_BASE_DIR,
    maxAgentTurns: process.env.MAX_AGENT_TURNS
      ? parseInt(process.env.MAX_AGENT_TURNS, 10)
      : undefined,
    agentTimeoutMs: process.env.AGENT_TIMEOUT_MS
      ? parseInt(process.env.AGENT_TIMEOUT_MS, 10)
      : undefined,
    toolTimeoutMs: process.env.TOOL_TIMEOUT_MS
      ? parseInt(process.env.TOOL_TIMEOUT_MS, 10)
      : undefined,
    logLevel: process.env.LOG_LEVEL,
    enableSemanticSearch: process.env.ENABLE_SEMANTIC_SEARCH === 'true',
    enableNotionBackend: process.env.ENABLE_NOTION_BACKEND === 'true',
    environment: process.env.ENVIRONMENT,
    nodeEnv: process.env.NODE_ENV,
  }

  // Provider-specific validation
  if (!raw.llmProvider) {
    throw new Error('LLM_PROVIDER is required (anthropic, openai, gemini, or ollama)')
  }

  if (raw.llmProvider === 'anthropic' && !raw.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic')
  }

  if (raw.llmProvider === 'openai' && !raw.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai')
  }

  if (raw.llmProvider === 'gemini' && !raw.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini')
  }

  // Ollama doesn't require an API key

  try {
    return ConfigSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.errors.map(e => `  ${e.path.join('.')}: ${e.message}`).join('\n')
      throw new Error(`Config validation failed:\n${details}`)
    }
    throw error
  }
}

/**
 * Singleton config instance
 */
let configInstance: Config | null = null

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig()
  }
  return configInstance
}

/**
 * Initialize config at startup
 */
export function initializeConfig(): Config {
  const config = getConfig()
  console.log(`✓ Config loaded:`)
  console.log(`  provider=${config.llmProvider}`)
  console.log(`  kbBaseDir=${config.kbBaseDir}`)
  console.log(`  maxAgentTurns=${config.maxAgentTurns}`)
  console.log(`  logLevel=${config.logLevel}`)
  return config
}
