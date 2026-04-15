import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import dayjs from 'dayjs'

export interface KbConfig {
  defaultBase?: string
  notion?: {
    token?: string
    parentPageId?: string
  }
  updatedAt?: string
  sessionBase?: string
}

export const KB_CONFIG_DIR = path.join(os.homedir(), '.kb')
export const KB_CONFIG_FILE = path.join(KB_CONFIG_DIR, 'config.json')

const SUPPORTED_CONFIG_PATHS = [
  'defaultBase',
  'notion',
  'notion.token',
  'notion.parentPageId',
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

export async function readKbConfig(configFile: string = KB_CONFIG_FILE): Promise<KbConfig> {
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
  configFile: string = KB_CONFIG_FILE,
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
    case 'defaultBase':
      return requireConfigValue(normalized.defaultBase, keyPath)
    case 'notion':
      return requireConfigValue(normalized.notion, keyPath)
    case 'notion.token':
      return requireConfigValue(normalized.notion?.token, keyPath)
    case 'notion.parentPageId':
      return requireConfigValue(normalized.notion?.parentPageId, keyPath)
    case 'updatedAt':
      return requireConfigValue(normalized.updatedAt, keyPath)
    default:
      throw new UnknownConfigKeyError(keyPath)
  }
}

export function setConfigValue(config: KbConfig, keyPath: string, value: string): KbConfig {
  assertSupportedConfigPath(keyPath)
  if (keyPath === 'updatedAt') {
    throw new ReadOnlyConfigKeyError(keyPath)
  }

  const next = normalizeKbConfig(config)
  switch (keyPath) {
    case 'defaultBase':
      next.defaultBase = value
      break
    case 'notion.token':
      next.notion = { ...next.notion, token: value }
      break
    case 'notion.parentPageId':
      next.notion = { ...next.notion, parentPageId: value }
      break
    case 'notion':
      throw new Error('INVALID_CONFIG_WRITE: notion requires a nested key such as notion.token')
    default:
      throw new UnknownConfigKeyError(keyPath)
  }

  return normalizeKbConfig(next)
}

export function unsetConfigValue(config: KbConfig, keyPath: string): KbConfig {
  assertSupportedConfigPath(keyPath)
  if (keyPath === 'updatedAt') {
    throw new ReadOnlyConfigKeyError(keyPath)
  }

  const next = normalizeKbConfig(config)
  switch (keyPath) {
    case 'defaultBase':
      delete next.defaultBase
      break
    case 'notion':
      delete next.notion
      break
    case 'notion.token':
      if (next.notion) {
        delete next.notion.token
      }
      break
    case 'notion.parentPageId':
      if (next.notion) {
        delete next.notion.parentPageId
      }
      break
    default:
      throw new UnknownConfigKeyError(keyPath)
  }

  return normalizeKbConfig(next)
}

export function resolveNotionToken(config: KbConfig): string | undefined {
  return (
    config.notion?.token?.trim() ||
    process.env.NOTION_TOKEN?.trim() ||
    process.env.NOTION_API_KEY?.trim()
  )
}

export function normalizeKbConfig(input: KbConfig): KbConfig {
  const normalized: KbConfig = {}

  if (typeof input.defaultBase === 'string' && input.defaultBase.trim()) {
    normalized.defaultBase = input.defaultBase.trim()
  }

  const notion = {
    token: typeof input.notion?.token === 'string' && input.notion.token.trim()
      ? input.notion.token.trim()
      : undefined,
    parentPageId: typeof input.notion?.parentPageId === 'string' && input.notion.parentPageId.trim()
      ? input.notion.parentPageId.trim()
      : undefined,
  }

  if (notion.token || notion.parentPageId) {
    normalized.notion = notion
  }

  if (typeof input.updatedAt === 'string' && input.updatedAt.trim()) {
    normalized.updatedAt = input.updatedAt
  }

  return normalized
}

function assertSupportedConfigPath(keyPath: string): asserts keyPath is SupportedConfigPath {
  if (!(SUPPORTED_CONFIG_PATHS as readonly string[]).includes(keyPath)) {
    throw new UnknownConfigKeyError(keyPath)
  }
}

function requireConfigValue<T>(value: T | undefined, keyPath: string): T {
  if (value === undefined) {
    throw new ConfigValueNotSetError(keyPath)
  }
  return value
}
