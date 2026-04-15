import os from 'node:os'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import dayjs from 'dayjs'

export interface BaseSelectionConfig {
  sessionBase?: string
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
  const existing = await readBaseConfig()
  const payload: BaseSelectionConfig = {
    ...existing,
    defaultBase: base,
    updatedAt: dayjs().toISOString(),
  }
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

export async function writeSessionBase(base: string): Promise<BaseSelectionConfig> {
  const existing = await readBaseConfig()
  const payload: BaseSelectionConfig = {
    ...existing,
    sessionBase: base,
    updatedAt: dayjs().toISOString(),
  }
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

export interface EffectiveBaseResolution {
  baseDir: string
  source: 'config.sessionBase' | 'config.defaultBase'
  baseName?: string
}

export async function resolveEffectiveBaseDir(
  cwd: string = process.cwd(),
  configOverride?: BaseSelectionConfig,
): Promise<EffectiveBaseResolution> {
  const config = configOverride ?? await readBaseConfig()

  if (config.sessionBase) {
    return {
      baseDir: resolveBaseToDir(config.sessionBase, cwd),
      source: 'config.sessionBase',
      baseName: config.sessionBase,
    }
  }

  if (config.defaultBase) {
    return {
      baseDir: resolveBaseToDir(config.defaultBase, cwd),
      source: 'config.defaultBase',
      baseName: config.defaultBase,
    }
  }

  throw new Error('No KB base configured. Set one with `kb use <base>` or `kb default <base>`.')
}

export function formatUseCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Using base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Saved as session base for immediate invocations.',
    'To persist for future invocations across sessions:',
    `  kb default ${base}`,
    '',
    'Environment fallback (only if no session/default is set):',
    `  KB_BASE=${base}`,
  ].join('\n')
}

export function formatDefaultCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Default base saved: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Current invocation precedence:',
    '  1) kb use session base',
    '  2) saved default base',
    '  3) KB_BASE',
  ].join('\n')
}
