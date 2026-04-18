import os from 'node:os'
import path from 'node:path'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readKbConfig, writeKbConfig, type KbConfig } from './kb-config'

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

function getKbSessionStateFile(): string {
  return path.join(getKbHomeDir(), 'session.json')
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
  const config = await readKbConfig()
  const session = await readBaseSession()
  return {
    activeBase: session.activeBase,
    selectedBase: config.selectedBase,
    updatedAt: config.updatedAt,
  }
}

export async function writeDefaultBase(base: string): Promise<BaseSelectionConfig> {
  const config = await readKbConfig()
  const saved = await writeKbConfig({ ...config, selectedBase: base })
  const session = await readBaseSession()
  return {
    activeBase: session.activeBase,
    selectedBase: saved.selectedBase,
    updatedAt: saved.updatedAt,
  }
}

export async function writeSessionBase(base: string): Promise<BaseSelectionConfig> {
  const session: BaseSelectionConfig = { activeBase: base }
  await mkdir(path.dirname(getKbSessionStateFile()), { recursive: true })
  await writeFile(getKbSessionStateFile(), `${JSON.stringify(session, null, 2)}\n`, 'utf8')
  const config = await readKbConfig()
  return {
    activeBase: base,
    selectedBase: config.selectedBase,
    updatedAt: config.updatedAt,
  }
}

export interface EffectiveBaseResolution {
  baseDir: string
  source: 'session.activeBase' | 'config.selectedBase'
  baseName: string
}

/**
 * Resolve which base to use.
 *
 * Priority:
 *   1. session.activeBase — session-scoped selection written by `kb use <base>`.
 *   2. config.selectedBase — persistent default saved by `kb use --default <base>`.
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
      source: 'session.activeBase',
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

  throw new Error(
    'No KB base configured. Use `kb use <base>` for the current session or `kb use --default <base>` to save a default.',
  )
}

/**
 * Format the output for `kb use <base>`.
 */
export function formatUseCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Using base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Switched the active base for this session.',
    'Use `kb use --default <base>` to save the preferred base for future runs.',
  ].join('\n')
}

export function formatDefaultCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Default base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Saved as the preferred base for future runs.',
    'Use `kb use <base>` when you want to switch bases temporarily.',
  ].join('\n')
}

async function readBaseSession(): Promise<BaseSelectionConfig> {
  try {
    const raw = await readFile(getKbSessionStateFile(), 'utf8')
    const parsed = JSON.parse(raw) as BaseSelectionConfig
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    return {
      activeBase: typeof parsed.activeBase === 'string' && parsed.activeBase.trim()
        ? parsed.activeBase.trim()
        : undefined,
    }
  } catch {
    return {}
  }
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
