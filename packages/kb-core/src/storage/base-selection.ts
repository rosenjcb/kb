import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CLI_ERROR_NO_KB_BASE } from '@kb/core/config/cli-prerequisites.js'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import { type KbConfig, readKbConfig } from '@kb/core/config/kb-config.js'
import {
  readActiveBaseName,
  readDefaultBaseName,
  writeActiveBaseName,
  writeDefaultBaseName,
} from '@kb/core/storage/base-state.js'

export interface BaseSelectionConfig {
  activeBase?: string
  defaultBase?: string
  updatedAt?: string
}

/**
 * Golden default base slug — the cluster's well-known base, the way Postgres
 * ships a `postgres` maintenance database. `kb-server start` binds this when no
 * base is named, so operators never have to pick one just to boot, and clients
 * that omit a base land here. See issue #173 / the Postgres analogy in README.
 */
export const DEFAULT_BASE_SLUG = 'base'

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

/** Legacy file; migrated into `active-base` and removed. */
function getLegacySessionStateFile(): string {
  return path.join(getKbHomeDir(), 'session.json')
}

/**
 * One-time migration: `~/.kb/session.json` → `active-base`, then delete legacy file.
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
    parsed &&
    typeof parsed === 'object' &&
    'activeBase' in parsed &&
    typeof (parsed as { activeBase?: unknown }).activeBase === 'string'
      ? (parsed as { activeBase: string }).activeBase.trim()
      : undefined

  if (legacyActive && !(await readActiveBaseName())) {
    await writeActiveBaseName(legacyActive)
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

export async function ensureOperationalBaseDir(
  base: string,
  cwd: string = process.cwd()
): Promise<string> {
  const resolved = resolveBaseToDir(base, cwd)
  if (isPathLike(base.trim())) {
    return resolved
  }

  await mkdir(resolved, { recursive: true })
  await migrateLegacyBaseDir(base, resolved)
  const sqlitePath = path.join(resolved, '.kb-index.sqlite')
  const legacySqlitePath = path.join(
    cwd,
    'sessions',
    'namespaces',
    normalizeAlias(base),
    'documents',
    '.kb-index.sqlite'
  )
  if (!(await pathExists(sqlitePath))) {
    if (await pathExists(legacySqlitePath)) {
      await copyFile(legacySqlitePath, sqlitePath)
    }
  }
  return resolved
}

export async function readBaseConfig(): Promise<BaseSelectionConfig> {
  await migrateLegacyKbSessionJson()
  return {
    activeBase: await readActiveBaseName(),
    defaultBase: await readDefaultBaseName(),
  }
}

export async function writeDefaultBase(base: string): Promise<BaseSelectionConfig> {
  await writeDefaultBaseName(base)
  return readBaseConfig()
}

export async function writeSessionBase(base: string): Promise<BaseSelectionConfig> {
  await writeActiveBaseName(base)
  return readBaseConfig()
}

export interface EffectiveBaseResolution {
  baseDir: string
  source: 'activeBase' | 'defaultBase'
  baseName: string
}

export interface BaseInfo {
  name: string
  path: string
  isActive: boolean
  isDefault: boolean
  lastModified: Date | null
}

/** List all initialized bases found under `~/.kb/sessions/`. */
export async function listAllBases(): Promise<BaseInfo[]> {
  const sessionsDir = path.join(getKbHomeDir(), 'sessions')
  if (!(await pathExists(sessionsDir))) return []

  const config = await readKbConfig()
  const entries = await readdir(sessionsDir)
  const bases: BaseInfo[] = []

  for (const entry of entries) {
    const basePath = path.join(sessionsDir, entry)
    const sqlitePath = path.join(basePath, '.kb-index.sqlite')
    if (!(await pathExists(sqlitePath))) continue

    let lastModified: Date | null = null
    try {
      const info = await stat(sqlitePath)
      lastModified = info.mtime
    } catch {
      // ignore
    }

    bases.push({
      name: entry,
      path: basePath,
      isActive: config.activeBase === entry,
      isDefault: config.defaultBase === entry,
      lastModified,
    })
  }

  return bases.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Resolve which base to use.
 *
 * Priority:
 *   1. active base — from `kb base use` (`~/.kb/state/active-base` or `KB_ACTIVE_BASE`).
 *   2. default base — from `kb base use --default` (`~/.kb/state/default-base` or `KB_BASE`).
 *
 * configOverride is accepted only for testing — real callers omit it.
 */
export async function resolveEffectiveBaseDir(
  cwd: string = process.cwd(),
  configOverride?: Pick<BaseSelectionConfig, 'activeBase' | 'defaultBase'> | KbConfig
): Promise<EffectiveBaseResolution> {
  const activeBase =
    configOverride !== undefined
      ? 'activeBase' in configOverride
        ? configOverride.activeBase
        : undefined
      : (await readBaseConfig()).activeBase

  if (activeBase) {
    return {
      baseDir: await ensureOperationalBaseDir(activeBase, cwd),
      source: 'activeBase',
      baseName: activeBase,
    }
  }

  const selected =
    configOverride !== undefined
      ? 'defaultBase' in configOverride
        ? configOverride.defaultBase
        : undefined
      : (await readBaseConfig()).defaultBase

  if (selected) {
    return {
      baseDir: await ensureOperationalBaseDir(selected, cwd),
      source: 'defaultBase',
      baseName: selected,
    }
  }

  throw new Error(CLI_ERROR_NO_KB_BASE)
}

/** Format the output after `base use <base>` (CLI: `kb base use`, TUI: `/base use`). */
export function formatUseCommandHelp(
  base: string,
  resolvedPath: string,
  mode: CmdMode = 'cli'
): string {
  return [
    `Using base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Switched the active base for this session.',
    `Use \`${cmd('base use --default <base>', mode)}\` to save the preferred base for future runs.`,
  ].join('\n')
}

/** Format the output after `base use --default` / `default` (CLI vs TUI via `mode`). */
export function formatDefaultCommandHelp(
  base: string,
  resolvedPath: string,
  mode: CmdMode = 'cli'
): string {
  return [
    `Default base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Saved as the preferred base for future runs.',
    `Use \`${cmd('base use <base>', mode)}\` when you want to switch bases temporarily.`,
  ].join('\n')
}

export interface DeleteBaseResult {
  basePath: string
  clearedActive: boolean
  clearedSelected: boolean
  purgedPaths: string[]
}

/**
 * Delete a named base: removes its session directory and clears any config
 * references to it. Only works for alias-style bases (not path-like).
 */
export async function deleteBase(
  base: string,
  cwd: string = process.cwd()
): Promise<DeleteBaseResult> {
  const trimmed = base.trim()
  if (!trimmed) throw new Error('Base name is required')
  if (isPathLike(trimmed)) {
    throw new Error(
      'kb base delete only works with named bases, not path-like references. Remove the directory manually.'
    )
  }

  const basePath = resolveBaseToDir(trimmed)
  const purgedPaths: string[] = []
  const alias = normalizeAlias(trimmed)
  const legacyBasePath = path.join(getKbHomeDir(), alias)
  const tmpCheckpointPath = path.join(cwd, '.tmp', 'kb-init', `${alias}-latest.checkpoint.json`)

  if (await pathExists(basePath)) {
    await rm(basePath, { recursive: true, force: true })
    purgedPaths.push(basePath)
  }
  if (legacyBasePath !== basePath && (await pathExists(legacyBasePath))) {
    await rm(legacyBasePath, { recursive: true, force: true })
    purgedPaths.push(legacyBasePath)
  }
  if (await pathExists(tmpCheckpointPath)) {
    await rm(tmpCheckpointPath, { force: true })
    purgedPaths.push(tmpCheckpointPath)
  }

  const config = await readKbConfig()
  const clearedActive = config.activeBase === trimmed
  const clearedSelected = config.defaultBase === trimmed

  if (clearedActive) {
    await rm(path.join(getKbHomeDir(), 'state', 'active-base'), { force: true }).catch(() => {})
  }
  if (clearedSelected) {
    await rm(path.join(getKbHomeDir(), 'state', 'default-base'), { force: true }).catch(() => {})
  }

  return { basePath, clearedActive, clearedSelected, purgedPaths }
}

export function printBaseDeleteHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('base delete', mode)} — delete a base and all its data`,
    '',
    'Usage:',
    `  ${cmd('base delete <base> [--force]', mode)}`,
    '',
    'Removes the session directory and clears the base from config.',
    mode === 'tui'
      ? '--force is required in the TUI (stdin is owned by the shell).'
      : 'Prompts for confirmation unless --force is passed.',
    '',
    'Examples:',
    `  ${cmd('base delete ci-test --force', mode)}`,
    ...(mode === 'cli' ? [`  ${cmd('base delete old-project', mode)}`] : []),
  ].join('\n')
}

export function formatDeleteBaseResult(
  base: string,
  result: DeleteBaseResult,
  mode: CmdMode = 'cli'
): string {
  const lines = [`Deleted base: ${base}`, `Removed path: ${result.basePath}`]
  if (result.clearedActive) lines.push('Cleared from active base (config.activeBase).')
  if (result.clearedSelected) lines.push('Cleared from default base (config.defaultBase).')
  lines.push('', `Use \`${cmd('base use <base>', mode)}\` to start a new base.`)
  return lines.join('\n')
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

/** Read `--flag <value>` when present; returns undefined if the flag or value is missing (does not throw). */
export function readOptionalCliValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (!v || v.startsWith('--')) return undefined
  return v
}

/** Remove `--flag <value>` pairs from argv (skips a single following token when it is not another flag). */
export function stripCliFlagWithValue(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]
    if (tok === undefined) continue
    if (tok === flag) {
      const v = args[i + 1]
      if (v && !v.startsWith('--')) i++
      continue
    }
    out.push(tok)
  }
  return out
}

/**
 * Resolve the KB session directory from optional `--base <name>` in argv,
 * otherwise the active / effective base (same rules as intent commands).
 */
export async function resolveKbStorageDirFromArgs(
  args: string[],
  cwd: string = process.cwd()
): Promise<string> {
  const base = readOptionalCliValue(args, '--base')
  if (base) return ensureOperationalBaseDir(base, cwd)
  return (await resolveEffectiveBaseDir(cwd)).baseDir
}
