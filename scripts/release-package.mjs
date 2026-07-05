/**
 * Release metadata for the post-split monorepo.
 *
 * Shipped CLI releases follow `@kb/client` (version + changelog + git tags).
 * kb-server Docker tags follow `@kb/server`. Root `kb-workspace` is private and
 * not versioned for releases.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = path.resolve(scriptDir, '..')

export const CLIENT_PKG_DIR = path.join(REPO_ROOT, 'packages', 'kb-client')
export const CLIENT_PKG_JSON = path.join(CLIENT_PKG_DIR, 'package.json')
export const CLIENT_CHANGELOG = path.join(CLIENT_PKG_DIR, 'CHANGELOG.md')

export const SERVER_PKG_DIR = path.join(REPO_ROOT, 'packages', 'kb-server')
export const SERVER_PKG_JSON = path.join(SERVER_PKG_DIR, 'package.json')
export const SERVER_CHANGELOG = path.join(SERVER_PKG_DIR, 'CHANGELOG.md')

/** @param {string} pkgJsonPath */
export function readPackageVersion(pkgJsonPath) {
  const { version } = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
  if (!version || typeof version !== 'string') {
    throw new Error(`Missing version in ${pkgJsonPath}`)
  }
  return version
}

export function readClientVersion() {
  return readPackageVersion(CLIENT_PKG_JSON)
}

export function readServerVersion() {
  return readPackageVersion(SERVER_PKG_JSON)
}
