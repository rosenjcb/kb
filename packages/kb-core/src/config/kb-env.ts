import { DEFAULT_KB_SERVER_PORT } from '@kb/core/config/kb-server-port.js'

/** Canonical KB client/server environment variables (see README). */
export const KB_ENV = {
  HOME: 'KB_HOME',
  SERVER_URL: 'KB_SERVER_URL',
  CONNECTION_STRING: 'KB_CONNECTION_STRING',
  HOST: 'KB_HOST',
  PORT: 'KB_PORT',
  SERVER_API_KEY: 'KB_SERVER_API_KEY',
  BASE: 'KB_BASE',
  ACTIVE_BASE: 'KB_ACTIVE_BASE',
  LLM_PROVIDER: 'KB_LLM_PROVIDER',
  FACT_RETRIEVAL_METHOD: 'KB_FACT_RETRIEVAL_METHOD',
} as const

export function readEnvHost(): string | undefined {
  return process.env.KB_HOST?.trim() || process.env.KBHOST?.trim() || undefined
}

export function readEnvPort(): number {
  const raw = process.env.KB_PORT?.trim() || process.env.KBPORT?.trim()
  if (!raw) return DEFAULT_KB_SERVER_PORT
  const port = Number.parseInt(raw, 10)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid ${KB_ENV.PORT}: ${raw}`)
  }
  return port
}

export function envVarHint(keyPath: string): string | undefined {
  switch (keyPath) {
    case 'server.host':
      return KB_ENV.HOST
    case 'server.port':
      return KB_ENV.PORT
    case 'server.apiKey':
      return KB_ENV.SERVER_API_KEY
    case 'server.base':
      return KB_ENV.BASE
    case 'llm.provider':
      return KB_ENV.LLM_PROVIDER
    case 'fact_retrieval_method':
      return KB_ENV.FACT_RETRIEVAL_METHOD
    case 'notion.token':
      return 'NOTION_TOKEN or NOTION_API_KEY'
    case 'notion.parentPageId':
      return 'NOTION_PARENT_PAGE_ID'
    case 'graph.enabled':
      return 'KB_GRAPH'
    default:
      return undefined
  }
}
