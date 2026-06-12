#!/usr/bin/env node
/**
 * Fail fast when Node is below package.json engines.node.
 * .nvmrc pins the exact dev version; engines is the minimum major.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

/** @param {string} spec engines.node value, e.g. ">=24" or ">=24.15.0" */
export function parseMinEngine(spec) {
  const m = String(spec).match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return [0, 0, 0]
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** @param {number[]} current @param {number[]} min */
export function versionGte(current, min) {
  for (let i = 0; i < 3; i++) {
    if (current[i] > min[i]) return true
    if (current[i] < min[i]) return false
  }
  return true
}

/**
 * @param {{ enginesNode?: string | null, currentVersion: string, nvmrc?: string | null }} opts
 * @returns {{ ok: true } | { ok: false, spec: string, currentVersion: string, nvmrc: string | null }}
 */
export function evaluateNodeVersion({ enginesNode, currentVersion, nvmrc = null }) {
  if (!enginesNode) return { ok: true }
  const min = parseMinEngine(enginesNode)
  const cur = currentVersion.split('.').map(n => Number.parseInt(n, 10))
  if (versionGte(cur, min)) return { ok: true }
  return { ok: false, spec: enginesNode, currentVersion, nvmrc }
}

/** @param {Extract<ReturnType<typeof evaluateNodeVersion>, { ok: false }>} result */
export function formatNodeVersionError(result) {
  const lines = [
    '',
    `kb requires Node ${result.spec} (current: v${result.currentVersion}).`,
  ]
  if (result.nvmrc) {
    lines.push(`This repo pins ${result.nvmrc} in .nvmrc — switch before install:`)
    lines.push('  nvm install && nvm use')
    lines.push('  fnm install && fnm use')
  } else {
    lines.push('Install Node 24+ and retry.')
  }
  lines.push('')
  return lines.join('\n')
}

export function runFromPackageJson(packageJsonPath, nvmrcPath, currentVersion) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const nvmrc = fs.existsSync(nvmrcPath) ? fs.readFileSync(nvmrcPath, 'utf8').trim() : null
  const outcome = evaluateNodeVersion({
    enginesNode: pkg.engines?.node ?? null,
    currentVersion,
    nvmrc,
  })
  if (outcome.ok) return 0
  console.error(formatNodeVersionError(outcome))
  return 1
}

const _isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (_isMain) {
  process.exit(
    runFromPackageJson(
      path.join(root, 'package.json'),
      path.join(root, '.nvmrc'),
      process.versions.node
    )
  )
}
