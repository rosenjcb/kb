import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CLI_ERROR_NO_KB_BASE } from './cli-prerequisites'
import { type CmdMode, cmd } from './cmd-ref'
import { type KbConfig, readKbConfig, writeKbConfig } from './kb-config'

export interface BaseSelectionConfig {
  activeBase?: string
  defaultBase?: string
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
    parsed &&
    typeof parsed === 'object' &&
    'activeBase' in parsed &&
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
  const config = await readKbConfig()
  return {
    activeBase: config.activeBase,
    defaultBase: config.defaultBase,
    updatedAt: config.updatedAt,
  }
}

export async function writeDefaultBase(base: string): Promise<BaseSelectionConfig> {
  const config = await readKbConfig()
  const saved = await writeKbConfig({ ...config, defaultBase: base })
  return {
    activeBase: saved.activeBase,
    defaultBase: saved.defaultBase,
    updatedAt: saved.updatedAt,
  }
}

export async function writeSessionBase(base: string): Promise<BaseSelectionConfig> {
  const config = await readKbConfig()
  const saved = await writeKbConfig({ ...config, activeBase: base })
  return {
    activeBase: saved.activeBase,
    defaultBase: saved.defaultBase,
    updatedAt: saved.updatedAt,
  }
}

export interface EffectiveBaseResolution {
  baseDir: string
  source: 'directory:.kb' | 'config.activeBase' | 'config.defaultBase'
  baseName: string
}

export interface BaseInfo {
  name: string
  path: string
  isActive: boolean
  isDefault: boolean
  lastModified: Date | null
}

/** Walk from startDir up to the filesystem root looking for a `.kb` file. Returns the base name inside or null. */
export async function findKbFile(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir)
  while (true) {
    const candidate = path.join(dir, '.kb')
    try {
      const contents = await readFile(candidate, 'utf8')
      const baseName = contents.trim()
      if (baseName) return baseName
    } catch {
      // not found here, keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Write a `.kb` file in the given directory containing the base name. */
export async function writeKbFile(dir: string, baseName: string): Promise<void> {
  await writeFile(path.join(dir, '.kb'), `${baseName}\n`, 'utf8')
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
 *   1. directory `.kb` file — found by walking CWD up to filesystem root.
 *   2. config.activeBase — current working base from `kb use <base>`.
 *   3. config.defaultBase — default from `kb use --default <base>` / `kb default <base>`.
 *
 * configOverride is accepted only for testing — real callers omit it.
 */
export async function resolveEffectiveBaseDir(
  cwd: string = process.cwd(),
  configOverride?: Pick<BaseSelectionConfig, 'activeBase' | 'defaultBase'> | KbConfig
): Promise<EffectiveBaseResolution> {
  // Only check .kb file in real (non-test) invocations
  if (configOverride === undefined) {
    const kbFileBase = await findKbFile(cwd)
    if (kbFileBase) {
      return {
        baseDir: await ensureOperationalBaseDir(kbFileBase, cwd),
        source: 'directory:.kb',
        baseName: kbFileBase,
      }
    }
  }

  const activeBase =
    configOverride !== undefined
      ? 'activeBase' in configOverride
        ? configOverride.activeBase
        : undefined
      : (await readBaseConfig()).activeBase

  if (activeBase) {
    return {
      baseDir: await ensureOperationalBaseDir(activeBase, cwd),
      source: 'config.activeBase',
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
      source: 'config.defaultBase',
      baseName: selected,
    }
  }

  throw new Error(CLI_ERROR_NO_KB_BASE)
}

/**
 * Format the output after `use <base>` (CLI: `kb use`, TUI: `/use`).
 * Pass `kbFileOverride` when a `.kb` file in the directory specifies a different base —
 * the user needs to know that the `.kb` file takes priority over what they just set.
 */
export function formatUseCommandHelp(
  base: string,
  resolvedPath: string,
  mode: CmdMode = 'cli',
  kbFileOverride?: string
): string {
  const lines = [
    `Using base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Switched the active base for this session.',
    `Use \`${cmd('base use --default <base>', mode)}\` to save the preferred base for future runs.`,
  ]
  if (kbFileOverride && kbFileOverride !== base) {
    lines.push(
      '',
      'Note: A .kb file in this directory always takes priority over the active and default bases.',
      `Commands run here will use "${kbFileOverride}", not "${base}".`
    )
  }
  return lines.join('\n')
}

/** Format the output after `base use --default` / `default` (CLI vs TUI via `mode`). */
export function formatDefaultCommandHelp(
  base: string,
  resolvedPath: string,
  mode: CmdMode = 'cli',
  kbFileOverride?: string
): string {
  const lines = [
    `Default base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Saved as the preferred base for future runs.',
    `Use \`${cmd('base use <base>', mode)}\` when you want to switch bases temporarily.`,
  ]
  if (kbFileOverride && kbFileOverride !== base) {
    lines.push(
      '',
      'Note: A .kb file in this directory always takes priority over the active and default bases.',
      `Commands run here will use "${kbFileOverride}", not "${base}".`
    )
  }
  return lines.join('\n')
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

  if (clearedActive || clearedSelected) {
    await writeKbConfig({
      ...config,
      activeBase: clearedActive ? undefined : config.activeBase,
      defaultBase: clearedSelected ? undefined : config.defaultBase,
    })
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
