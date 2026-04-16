import os from 'node:os'
import path from 'node:path'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { readKbConfig, writeKbConfig, type KbConfig } from './kb-config'

export interface BaseSelectionConfig {
  selectedBase?: string
  updatedAt?: string
}

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

export function getKbHomeDir(): string {
  const override = process.env.KB_HOME?.trim()
  return override ? path.resolve(override) : path.join(os.homedir(), '.kb')
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
  return path.join(getKbHomeDir(), 'sessions', alias)
}

export async function ensureOperationalBaseDir(base: string, cwd: string = process.cwd()): Promise<string> {
  const resolved = resolveBaseToDir(base, cwd)
  if (isPathLike(base.trim())) {
    return resolved
  }

  await mkdir(resolved, { recursive: true })
  const sqlitePath = path.join(resolved, '.kb-index.sqlite')
  const legacySqlitePath = path.join(cwd, 'sessions', 'namespaces', normalizeAlias(base), 'documents', '.kb-index.sqlite')
  if (!(await pathExists(sqlitePath))) {
    if (await pathExists(legacySqlitePath)) {
      await copyFile(legacySqlitePath, sqlitePath)
    }
  }
  return resolved
}

export async function readBaseConfig(): Promise<BaseSelectionConfig> {
  const config = await readKbConfig()
  return {
    selectedBase: config.selectedBase,
    updatedAt: config.updatedAt,
  }
}

export async function writeDefaultBase(base: string): Promise<BaseSelectionConfig> {
  const config = await readKbConfig()
  const saved = await writeKbConfig({ ...config, selectedBase: base })
  return {
    selectedBase: saved.selectedBase,
    updatedAt: saved.updatedAt,
  }
}

export interface EffectiveBaseResolution {
  baseDir: string
  source: 'env.KB_BASE' | 'config.selectedBase'
  baseName: string
}

/**
 * Resolve which base to use.
 *
 * Priority:
 *   1. KB_BASE env var  — session-scoped; set with `export KB_BASE=<base>` in the shell.
 *                         Clears automatically when the terminal is closed.
 *   2. config.selectedBase — persistent default saved by `kb default <base>`.
 *
 * configOverride is accepted only for testing — real callers omit it.
 */
export async function resolveEffectiveBaseDir(
  cwd: string = process.cwd(),
  configOverride?: Pick<BaseSelectionConfig, 'selectedBase'> | KbConfig,
): Promise<EffectiveBaseResolution> {
  const envBase = process.env.KB_BASE?.trim()
  if (envBase) {
    return {
      baseDir: await ensureOperationalBaseDir(envBase, cwd),
      source: 'env.KB_BASE',
      baseName: envBase,
    }
  }

  const selected = configOverride !== undefined
    ? ('selectedBase' in configOverride ? configOverride.selectedBase : undefined)
    : (await readBaseConfig()).selectedBase

  if (selected) {
    return {
      baseDir: await ensureOperationalBaseDir(selected, cwd),
      source: 'config.selectedBase',
      baseName: selected,
    }
  }

  throw new Error(
    'No KB base configured. Run `kb default <base>` to set a persistent default, ' +
    'or run `export KB_BASE=<base>` to set one for this shell session only.',
  )
}

/**
 * Format the output for `kb use <base>`.
 * We can't write to the parent shell's environment, so we print the export line instead.
 */
export function formatUseCommandHelp(base: string): string {
  return [
    `To activate "${base}" for this shell session, run:`,
    '',
    `  export KB_BASE=${base}`,
    '',
    'This is scoped to the current terminal and cleared when you close it.',
    'To save a persistent default instead: kb default <base>',
  ].join('\n')
}

export function formatDefaultCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Default base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Saved as the persistent default for all future runs.',
    'To override for this session only: export KB_BASE=<base>',
  ].join('\n')
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}
