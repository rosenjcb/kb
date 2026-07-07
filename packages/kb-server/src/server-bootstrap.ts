/**
 * Env + flag bootstrap config for `kb-server start` in a fresh node/container.
 *
 * Lets an operator launch the server without any interactive setup: the base name, the git
 * repos to build + serve, and the index-ignore patterns are all declared through the
 * environment (or `--flags`), and the server boot-builds the index from them on an empty
 * volume. Everything the server needs is an environment variable — there is no on-disk
 * config file to manage, because these run as Docker service nodes, not local checkouts.
 *
 * Resolution precedence (highest wins) — explicit flags beat env:
 *   base:   `--base` flag > `KB_SERVER_BASE_NAME` / `KB_BASE` env
 *   repos:  `--git` flag(s) > `KB_SERVER_BASE_GIT_REPOS` / `KB_GIT_REPOS` env
 *   ignore: `KB_SERVER_IGNORE` env
 *
 * `KB_SERVER_BASE_NAME` / `KB_SERVER_BASE_GIT_REPOS` are the server-scoped names; the
 * legacy `KB_BASE` / `KB_GIT_REPOS` remain supported as fallbacks for back-compat. Repo
 * lists accept comma- and/or whitespace/newline-separated entries (handy for multi-line
 * container env) and each entry keeps its inline `#<branch>` pin.
 *
 * This module is intentionally pure (parsing + plan resolution, no I/O) so it is
 * unit-testable without Docker.
 */

import { readIgnorePatternsFromEnv } from '@kb/core/config/kb-ignore.js'
import { type GitTarget, parseGitTarget } from '@kb/core/ops/init-cli.js'
import { readOptionalCliValue } from '@kb/core/storage/base-selection.js'

/** Resolved, normalized bootstrap plan consumed by the server boot-build. */
export interface BootstrapPlan {
  /** Resolved base name, if any (callers fall back to the effective base). */
  base?: string
  /** Repositories to build the index from on a fresh volume. */
  gitTargets: GitTarget[]
  /** Gitignore-style patterns to skip while indexing. */
  ignore?: string[]
  /** Where the repos came from, for a clear boot log line. */
  source: 'flags' | 'env' | 'none'
}

/**
 * How the server treats a cold start with no prepared index.
 *
 * - `auto` (default): build/scan from declared repos on an empty volume, and
 *   fold newly-declared repos into a warm volume — the historical behavior.
 * - `snapshot-only`: never run the heavy build. Serve an existing index as-is
 *   and, when none exists, refuse and surface "no snapshot available" so a
 *   lightweight serving worker cannot accidentally do builder-sized work. The
 *   snapshot must be supplied out of band (`kb-server start --from <dir>`,
 *   `kb-server import`, or a mounted volume).
 */
export type BootstrapPolicy = 'auto' | 'snapshot-only'

/**
 * Resolve the bootstrap policy: `--bootstrap-policy` flag > `KB_SERVER_BOOTSTRAP_POLICY`
 * env > default `auto`. Throws on an unrecognized value so a typo fails fast.
 */
export function resolveBootstrapPolicy(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): BootstrapPolicy {
  const raw = (
    readOptionalCliValue(args, '--bootstrap-policy') ??
    env.KB_SERVER_BOOTSTRAP_POLICY ??
    ''
  )
    .trim()
    .toLowerCase()
  if (raw === '' || raw === 'auto') return 'auto'
  if (raw === 'snapshot-only') return 'snapshot-only'
  throw new Error(`Invalid bootstrap policy "${raw}" — expected "auto" or "snapshot-only".`)
}

/**
 * Resolve the local snapshot directory to adopt at boot: `--from` flag >
 * `KB_SERVER_SNAPSHOT` env. This is a path already present on the local
 * filesystem (a mounted volume, an unpacked artifact) — the server never
 * downloads it. Returns undefined when no snapshot is supplied.
 */
export function resolveSnapshotSource(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const raw = (readOptionalCliValue(args, '--from') ?? env.KB_SERVER_SNAPSHOT ?? '').trim()
  return raw.length > 0 ? raw : undefined
}

/** Split a comma- and/or whitespace/newline-separated `url[#branch]` list into git targets. */
export function parseReposEnv(value: string | undefined, defaultBranch?: string): GitTarget[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => parseGitTarget(entry, defaultBranch))
}

/**
 * Resolve the bootstrap plan from CLI flags and env vars (see precedence in the module
 * header). `--branch` is the fallback branch for any target without an inline `#branch`.
 */
export async function resolveBootstrapPlan(args: string[]): Promise<BootstrapPlan> {
  const defaultBranch = readOptionalCliValue(args, '--branch')

  // Base name: --base flag > KB_SERVER_BASE_NAME > KB_BASE.
  const cliBase = readOptionalCliValue(args, '--base')?.trim()
  const envBase = process.env.KB_SERVER_BASE_NAME?.trim() || process.env.KB_BASE?.trim()
  const base = cliBase || envBase || undefined

  // Repos: --git flags > KB_SERVER_BASE_GIT_REPOS / KB_GIT_REPOS env.
  const flagTargets = readAllCliValues(args, '--git').map(raw => parseGitTarget(raw, defaultBranch))
  const envReposRaw = process.env.KB_SERVER_BASE_GIT_REPOS ?? process.env.KB_GIT_REPOS
  const envTargets = parseReposEnv(envReposRaw, defaultBranch)

  let gitTargets: GitTarget[]
  let source: BootstrapPlan['source']
  if (flagTargets.length > 0) {
    gitTargets = flagTargets
    source = 'flags'
  } else if (envTargets.length > 0) {
    gitTargets = envTargets
    source = 'env'
  } else {
    gitTargets = []
    source = 'none'
  }

  const envIgnore = readIgnorePatternsFromEnv()
  const ignore = envIgnore.length > 0 ? envIgnore : undefined
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
