import os from 'node:os'
import path from 'node:path'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { readKbConfig, writeKbConfig, type KbConfig } from './kb-config'
import { CLI_ERROR_NO_KB_BASE } from './cli-prerequisites'
import { cmd, type CmdMode } from './cmd-ref'

export interface BaseSelectionConfig {
  activeBase?: string
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

/** Legacy file; migrated into `config.json` as `activeBase` and then removed. */
function getLegacySessionStateFile(): string {
  return path.join(getKbHomeDir(), 'session.json')
}

/**
 * One-time migration: `~/.kb/session.json` → `config.json` (`activeBase`), then delete legacy file.
 * Call early at process startup so later `readKbConfig()` sees merged state.
 */
export async function migrateLegacyKbSessionJson(): Promise<void> {
  const legacyPath = getLegacySessionStateFile()
  if (!(await pathExists(legacyPath))) {
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(legacyPath, 'utf8'))
  } catch {
    await rm(legacyPath, { force: true })
    return
  }

  const legacyActive =
    parsed && typeof parsed === 'object' && 'activeBase' in parsed &&
    typeof (parsed as { activeBase?: unknown }).activeBase === 'string'
      ? (parsed as { activeBase: string }).activeBase.trim()
      : undefined

  const config = await readKbConfig()
  if (legacyActive && !config.activeBase) {
    await writeKbConfig({ ...config, activeBase: legacyActive })
  }

  await rm(legacyPath, { force: true })
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
  await migrateLegacyBaseDir(base, resolved)
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
  await migrateLegacyKbSessionJson()
  const config = await readKbConfig()
  return {
    activeBase: config.activeBase,
    selectedBase: config.selectedBase,
    updatedAt: config.updatedAt,
  }
}

export async function writeDefaultBase(base: string): Promise<BaseSelectionConfig> {
  const config = await readKbConfig()
  const saved = await writeKbConfig({ ...config, selectedBase: base })
  return {
    activeBase: saved.activeBase,
    selectedBase: saved.selectedBase,
    updatedAt: saved.updatedAt,
  }
}

export async function writeSessionBase(base: string): Promise<BaseSelectionConfig> {
  const config = await readKbConfig()
  const saved = await writeKbConfig({ ...config, activeBase: base })
  return {
    activeBase: saved.activeBase,
    selectedBase: saved.selectedBase,
    updatedAt: saved.updatedAt,
  }
}

export interface EffectiveBaseResolution {
  baseDir: string
  source: 'config.activeBase' | 'config.selectedBase'
  baseName: string
}

/**
 * Resolve which base to use.
 *
 * Priority:
 *   1. config.activeBase — current working base from `kb use <base>` (persisted in ~/.kb/config.json).
 *   2. config.selectedBase — default from `kb use --default <base>` / `kb default <base>`.
 *
 * configOverride is accepted only for testing — real callers omit it.
 */
export async function resolveEffectiveBaseDir(
  cwd: string = process.cwd(),
  configOverride?: Pick<BaseSelectionConfig, 'activeBase' | 'selectedBase'> | KbConfig,
): Promise<EffectiveBaseResolution> {
  const activeBase = configOverride !== undefined
    ? ('activeBase' in configOverride ? configOverride.activeBase : undefined)
    : (await readBaseConfig()).activeBase

  if (activeBase) {
    return {
      baseDir: await ensureOperationalBaseDir(activeBase, cwd),
      source: 'config.activeBase',
      baseName: activeBase,
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

  throw new Error(CLI_ERROR_NO_KB_BASE)
}

/**
 * Format the output after `use <base>` (CLI: `kb use`, TUI: `/use`).
 */
export function formatUseCommandHelp(base: string, resolvedPath: string, mode: CmdMode = 'cli'): string {
  return [
    `Using base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Switched the active base for this session.',
    `Use \`${cmd('use --default <base>', mode)}\` to save the preferred base for future runs.`,
  ].join('\n')
}

/** Format the output after `use --default` / `default` (CLI vs TUI via `mode`). */
export function formatDefaultCommandHelp(base: string, resolvedPath: string, mode: CmdMode = 'cli'): string {
  return [
    `Default base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Saved as the preferred base for future runs.',
    `Use \`${cmd('use <base>', mode)}\` when you want to switch bases temporarily.`,
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

async function migrateLegacyBaseDir(base: string, resolved: string): Promise<void> {
  const alias = normalizeAlias(base)
  if (!alias || alias === 'sessions') {
    return
  }

  const legacyRoot = path.join(getKbHomeDir(), alias)
  if (legacyRoot === resolved || !(await pathExists(legacyRoot))) {
    return
  }

  const entries = await readdir(legacyRoot)
  for (const entry of entries) {
    const source = path.join(legacyRoot, entry)
    const destination = path.join(resolved, entry)
    if (await pathExists(destination)) {
      continue
    }
    await movePath(source, destination)
  }

  await rm(legacyRoot, { recursive: true, force: true })
}

async function movePath(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  try {
    await rename(source, destination)
    return
  } catch {
    await cp(source, destination, { recursive: true, force: false })
    await rm(source, { recursive: true, force: true })
  }
}
