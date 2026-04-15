import os from 'node:os'
import path from 'node:path'
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
  const config = await readKbConfig()
  return {
    selectedBase: config.selectedBase,
    updatedAt: config.updatedAt,
  }
}

export async function writeSelectedBase(base: string): Promise<BaseSelectionConfig> {
  const config = await readKbConfig()
  const saved = await writeKbConfig({
    ...config,
    selectedBase: base,
  })
  return {
    selectedBase: saved.selectedBase,
    updatedAt: saved.updatedAt,
  }
}

export async function writeDefaultBase(base: string): Promise<BaseSelectionConfig> {
  return writeSelectedBase(base)
}

export async function writeSessionBase(base: string): Promise<BaseSelectionConfig> {
  return writeSelectedBase(base)
}

export interface EffectiveBaseResolution {
  baseDir: string
  source: 'config.selectedBase'
  baseName?: string
}

export async function resolveEffectiveBaseDir(
  cwd: string = process.cwd(),
  configOverride?: BaseSelectionConfig | KbConfig,
): Promise<EffectiveBaseResolution> {
  const config = configOverride
    ? {
      selectedBase: 'selectedBase' in configOverride ? configOverride.selectedBase : undefined,
      updatedAt: configOverride.updatedAt,
    }
    : await readBaseConfig()

  if (config.selectedBase) {
    return {
      baseDir: resolveBaseToDir(config.selectedBase, cwd),
      source: 'config.selectedBase',
      baseName: config.selectedBase,
    }
  }

  throw new Error('No KB base configured. Set one with `kb use <base>` or `kb default <base>`.')
}

export function formatUseCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Selected base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Saved as the active base for future invocations.',
    'Use `kb default <base>` or `kb use <base>` interchangeably.',
  ].join('\n')
}

export function formatDefaultCommandHelp(base: string, resolvedPath: string): string {
  return [
    `Selected base: ${base}`,
    `Resolved path: ${resolvedPath}`,
    '',
    'Saved as the active base for future invocations.',
    'Use `kb use <base>` or `kb default <base>` interchangeably.',
  ].join('\n')
}
