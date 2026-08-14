/**
 * Configuration loader and validator
 * Loads environment at startup, validates, fails fast on errors
 * See: Ticket 006 - Environment Loading Policy
 */

import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const DEFAULT_KB_BASE_DIR = path.join(os.homedir(), '.kb', 'sessions', 'default')

const ConfigSchema = z.object({
  ollamaEndpoint: z.string().url().optional().default('http://localhost:11434'),

  // KB Storage
  kbBaseDir: z.string().default(DEFAULT_KB_BASE_DIR),

  // Agent Loop Tuning
  maxAgentTurns: z.number().int().min(1).default(10),
  agentTimeoutMs: z.number().int().min(1000).default(300000),
  toolTimeoutMs: z.number().int().min(1000).default(30000),

  // Observability
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Feature Flags
  enableSemanticSearch: z.boolean().default(false),

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
    ollamaEndpoint: process.env.OLLAMA_ENDPOINT,
    kbBaseDir: process.env.KB_BASE_DIR,
    maxAgentTurns: process.env.MAX_AGENT_TURNS
      ? Number.parseInt(process.env.MAX_AGENT_TURNS, 10)
      : undefined,
    agentTimeoutMs: process.env.AGENT_TIMEOUT_MS
      ? Number.parseInt(process.env.AGENT_TIMEOUT_MS, 10)
      : undefined,
    toolTimeoutMs: process.env.TOOL_TIMEOUT_MS
      ? Number.parseInt(process.env.TOOL_TIMEOUT_MS, 10)
      : undefined,
    logLevel: process.env.LOG_LEVEL,
    enableSemanticSearch: process.env.ENABLE_SEMANTIC_SEARCH === 'true',
    enableNotionBackend: process.env.ENABLE_NOTION_BACKEND === 'true',
    environment: process.env.ENVIRONMENT,
    nodeEnv: process.env.NODE_ENV,
  }

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
  const provider = process.env.OPENAI_API_KEY
    ? 'openai'
    : process.env.ANTHROPIC_API_KEY
      ? 'anthropic'
      : process.env.GEMINI_API_KEY
        ? 'gemini'
        : 'ollama'
  console.log('✓ Config loaded:')
  console.log(`  provider=${provider}`)
  console.log(`  kbBaseDir=${config.kbBaseDir}`)
  console.log(`  maxAgentTurns=${config.maxAgentTurns}`)
  console.log(`  logLevel=${config.logLevel}`)
  return config
}
