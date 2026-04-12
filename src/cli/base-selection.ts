import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import dayjs from 'dayjs'

export interface BaseSelectionConfig {
  defaultBase?: string
  updatedAt?: string
}

const CONFIG_DIR = path.join(os.homedir(), '.kb')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

function isPathLike(base: string): boolean {
  return base.startsWith('/') || base.startsWith('.') || base.startsWith('~')
}

function normalizeAlias(base: string): string {
  return base.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()
}

function expandTilde(inputPath: string): string {
  if (!inputPath.startsWith('~')) return inputPath
  return path.join(os.homedir(), inputPath.slice(1))
}

export function resolveBaseToDir(base: string, cwd: string = process.cwd()): string {
  const trimmed = base.trim()
  if (!trimmed) {
    throw new Error('Base value is required')
  }

  if (isPathLike(trimmed)) {
    const expanded = expandTilde(trimmed)
    return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)
  }

  const alias = normalizeAlias(trimmed)
  return path.join(cwd, 'sessions', 'namespaces', alias, 'documents')
}

export async function readBaseConfig(): Promise<BaseSelectionConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw) as BaseSelectionConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeDefaultBase(base: string): Promise<BaseSelectionConfig> {
  const payload: BaseSelectionConfig = {
    defaultBase: base,
    updatedAt: dayjs().toISOString(),
  }
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

export interface EffectiveBaseResolution {
  baseDir: string
  source: 'env.KB_BASE_DIR' | 'env.KB_BASE' | 'config.defaultBase' | 'fallback'
  baseName?: string
}

export async function resolveEffectiveBaseDir(
  cwd: string = process.cwd(),
  configOverride?: BaseSelectionConfig,
): Promise<EffectiveBaseResolution> {
  const explicitBaseDir = (process.env.KB_BASE_DIR || '').trim()
  if (explicitBaseDir) {
    return {
      baseDir: path.isAbsolute(explicitBaseDir)
        ? explicitBaseDir
        : path.resolve(cwd, explicitBaseDir),
      source: 'env.KB_BASE_DIR',
    }
  }

  const envBase = (process.env.KB_BASE || '').trim()
  if (envBase) {
    return {
      baseDir: resolveBaseToDir(envBase, cwd),
      source: 'env.KB_BASE',
      baseName: envBase,
    }
  }

  const config = configOverride ?? await readBaseConfig()
  if (config.defaultBase) {
    return {
      baseDir: resolveBaseToDir(config.defaultBase, cwd),
      source: 'config.defaultBase',
      baseName: config.defaultBase,
    }
  }

  const fallbackBase = 'default'
  return {
    baseDir: resolveBaseToDir(fallbackBase, cwd),
    source: 'fallback',
    baseName: fallbackBase,
  }
}

export function formatUseCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Using base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'To apply for current shell session:',
    `  export KB_BASE="${base}"`,
    '',
    'To persist for future invocations:',
    `  kb default ${base}`,
  ].join('\n')
}

export function formatDefaultCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Default base saved: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Current invocation precedence:',
    '  1) KB_BASE_DIR',
    '  2) KB_BASE',
    '  3) saved default base',
    '  4) fallback: default',
  ].join('\n')
}
