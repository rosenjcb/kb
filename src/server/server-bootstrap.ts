/**
 * Declarative + env bootstrap config for `kb server start` in a fresh node/container.
 *
 * Lets an operator launch the server without first running the interactive
 * `kb init` / `kb base` flow. The base name and the git repos to build + serve are
 * declared up front and the server boot-builds the index from them on an empty volume.
 *
 * Resolution precedence (highest wins) — explicit inputs beat the declarative file:
 *   base:  `--base` flag > `KB_SERVER_BASE_NAME` / `KB_BASE` env > manifest `base`
 *   repos: `--git` flag(s) > `KB_SERVER_BASE_GIT_REPOS` / `KB_GIT_REPOS` env > manifest `repos`
 *   ignore:`KB_SERVER_BASE_IGNORE` / `KB_IGNORE` env > manifest `ignore`
 *
 * `KB_SERVER_BASE_NAME` / `KB_SERVER_BASE_GIT_REPOS` are the server-scoped names; the
 * legacy `KB_BASE` / `KB_GIT_REPOS` remain supported as fallbacks for back-compat. Repo
 * lists accept comma- and/or whitespace/newline-separated entries (handy for multi-line
 * container env) and each entry keeps its inline `#<branch>` pin. Ignore patterns accept
 * comma- and/or newline-separated gitignore-style patterns.
 *
 * The `kb-server.json` manifest is the idiomatic artifact for container / IaC deploys:
 * declarative, version-controllable, and able to express per-repo branches plus repo-local
 * ignore patterns. It is the lowest-precedence fallback, so
 * existing env-only deployments are unaffected.
 *
 * This module is intentionally pure (parsing + plan resolution; the only I/O is reading
 * the manifest file) so it is unit-testable without Docker.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getKbHomeDir, readOptionalCliValue } from '../cli/base-selection.js'
import { type GitTarget, parseGitTarget } from '../cli/init-cli.js'

/** A repository entry in a manifest: a `url[#branch]` string or `{ url, branch, ignore }` object. */
export interface BootstrapRepo {
  url: string
  branch?: string
  ignore?: string[]
}

/** Declarative shape of a `kb-server.json` manifest (every field optional). */
export interface BootstrapManifest {
  /** Base name to build + serve (lowest-precedence fallback under `--base` / env). */
  base?: string
  /** Git remotes to clone + index on first boot. */
  repos?: Array<string | BootstrapRepo>
  /** Gitignore-style patterns to skip while indexing (persisted to the base meta). */
  ignore?: string[]
}

/** Resolved, normalized bootstrap plan consumed by the server boot-build. */
export interface BootstrapPlan {
  /** Resolved base name, if any (callers fall back to the effective base). */
  base?: string
  /** Repositories to build the index from on a fresh volume. */
  gitTargets: GitTarget[]
  /** Gitignore-style patterns to skip while indexing. */
  ignore?: string[]
  /** Where the repos came from, for a clear boot log line. */
  source: 'flags' | 'env' | 'manifest' | 'none'
}

const DEFAULT_MANIFEST_NAME = 'kb-server.json'

/** Split a comma- and/or whitespace/newline-separated `url[#branch]` list into git targets. */
export function parseReposEnv(value: string | undefined, defaultBranch?: string): GitTarget[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => parseGitTarget(entry, defaultBranch))
}

/** Split a comma- and/or newline-separated ignore-pattern list into trimmed patterns. */
export function parseIgnoreEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\n]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

/** Normalize a manifest repo entry (string or object) into a GitTarget. */
function repoToGitTarget(repo: string | BootstrapRepo, defaultBranch?: string): GitTarget {
  if (typeof repo === 'string') return parseGitTarget(repo, defaultBranch)
  const url = repo.url?.trim()
  if (!url) throw new Error('bootstrap manifest: each repo entry needs a non-empty "url"')
  // An inline `#branch` in the url still wins; otherwise the object branch, then the default.
  return {
    ...parseGitTarget(url, repo.branch?.trim() || defaultBranch),
    ignorePatterns: repo.ignore?.map(p => p.trim()).filter(p => p.length > 0),
  }
}

/** Validate + normalize parsed JSON into a BootstrapManifest, throwing on malformed input. */
export function normalizeBootstrapManifest(parsed: unknown): BootstrapManifest {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('bootstrap manifest must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  const manifest: BootstrapManifest = {}

  if (obj.base !== undefined) {
    if (typeof obj.base !== 'string' || !obj.base.trim()) {
      throw new Error('bootstrap manifest: "base" must be a non-empty string')
    }
    manifest.base = obj.base.trim()
  }
  if (obj.repos !== undefined) {
    if (!Array.isArray(obj.repos)) {
      throw new Error('bootstrap manifest: "repos" must be an array')
    }
    manifest.repos = (obj.repos as unknown[]).map(repo => {
      if (typeof repo === 'string') return repo
      if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
        throw new Error('bootstrap manifest: each repo must be a string or object')
      }
      const record = repo as Record<string, unknown>
      if (typeof record.url !== 'string' || !record.url.trim()) {
        throw new Error('bootstrap manifest: each repo object needs a non-empty "url"')
      }
      const normalized: BootstrapRepo = { url: record.url.trim() }
      if (record.branch !== undefined) {
        if (typeof record.branch !== 'string') {
          throw new Error('bootstrap manifest: repo "branch" must be a string')
        }
        normalized.branch = record.branch.trim()
      }
      if (record.ignore !== undefined) {
        if (!Array.isArray(record.ignore) || record.ignore.some(p => typeof p !== 'string')) {
          throw new Error('bootstrap manifest: repo "ignore" must be an array of strings')
        }
        normalized.ignore = (record.ignore as string[]).map(p => p.trim()).filter(p => p.length > 0)
      }
      return normalized
    })
  }
  if (obj.ignore !== undefined) {
    if (!Array.isArray(obj.ignore) || obj.ignore.some(p => typeof p !== 'string')) {
      throw new Error('bootstrap manifest: "ignore" must be an array of strings')
    }
    manifest.ignore = (obj.ignore as string[]).map(p => p.trim()).filter(p => p.length > 0)
  }
  return manifest
}

/** Read + parse a manifest file. Returns null when it does not exist; throws on bad JSON/shape. */
export async function readBootstrapManifest(filePath: string): Promise<BootstrapManifest | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`bootstrap manifest at ${filePath} is not valid JSON: ${(err as Error).message}`)
  }
  return normalizeBootstrapManifest(parsed)
}

/**
 * Candidate manifest paths: an explicit `--bootstrap` / `KB_SERVER_BOOTSTRAP` /
 * `KB_BOOTSTRAP_FILE` location, else `kb-server.json` in the CWD or `$KB_HOME`.
 */
function manifestCandidates(args: string[], cwd: string): string[] {
  const explicit =
    readOptionalCliValue(args, '--bootstrap') ??
    process.env.KB_SERVER_BOOTSTRAP?.trim() ??
    process.env.KB_BOOTSTRAP_FILE?.trim()
  if (explicit) return [path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit)]
  return [path.join(cwd, DEFAULT_MANIFEST_NAME), path.join(getKbHomeDir(), DEFAULT_MANIFEST_NAME)]
}

async function loadManifest(args: string[], cwd: string): Promise<BootstrapManifest | null> {
  for (const candidate of manifestCandidates(args, cwd)) {
    const manifest = await readBootstrapManifest(candidate)
    if (manifest) return manifest
  }
  return null
}

/**
 * Resolve the bootstrap plan from CLI flags, env vars, and an optional `kb-server.json`
 * manifest. Explicit inputs win over the declarative file (see precedence in the module
 * header). `--branch` is the fallback branch for any target without an inline `#branch`.
 */
export async function resolveBootstrapPlan(
  args: string[],
  cwd: string = process.cwd()
): Promise<BootstrapPlan> {
  const defaultBranch = readOptionalCliValue(args, '--branch')
  const manifest = await loadManifest(args, cwd)

  // Base name: --base flag > KB_SERVER_BASE_NAME > KB_BASE > manifest.
  const cliBase = readOptionalCliValue(args, '--base')?.trim()
  const envBase = process.env.KB_SERVER_BASE_NAME?.trim() || process.env.KB_BASE?.trim()
  const base = cliBase || envBase || manifest?.base

  // Repos: --git flags > KB_SERVER_BASE_GIT_REPOS / KB_GIT_REPOS env > manifest.
  const flagTargets = readAllCliValues(args, '--git').map(raw => parseGitTarget(raw, defaultBranch))
  const envReposRaw = process.env.KB_SERVER_BASE_GIT_REPOS ?? process.env.KB_GIT_REPOS
  const envTargets = parseReposEnv(envReposRaw, defaultBranch)
  const manifestTargets = (manifest?.repos ?? []).map(repo => repoToGitTarget(repo, defaultBranch))
  const envIgnore = parseIgnoreEnv(process.env.KB_SERVER_BASE_IGNORE ?? process.env.KB_IGNORE)

  let gitTargets: GitTarget[]
  let source: BootstrapPlan['source']
  if (flagTargets.length > 0) {
    gitTargets = flagTargets
    source = 'flags'
  } else if (envTargets.length > 0) {
    gitTargets = envTargets
    source = 'env'
  } else if (manifestTargets.length > 0) {
    gitTargets = manifestTargets
    source = 'manifest'
  } else {
    gitTargets = []
    source = 'none'
  }

  const ignore =
    envIgnore.length > 0
      ? envIgnore
      : manifest?.ignore && manifest.ignore.length > 0
        ? manifest.ignore
        : undefined
  return { base, gitTargets, ignore, source }
}

/** Collect every `--flag <value>` occurrence (repeatable flags such as `--git`). */
function readAllCliValues(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue
    const value = args[i + 1]
    if (value && !value.startsWith('--')) out.push(value)
  }
  return out
}
