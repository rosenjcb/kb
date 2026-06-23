import { spawn } from 'node:child_process'
import { repoSlugFromGitUrl } from './base-meta'

type GitCommandEnv = Record<string, string | undefined>

function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GITHUB_TOKEN || env.GH_TOKEN
}

export function buildGitAuthEnv(env: NodeJS.ProcessEnv = process.env): GitCommandEnv {
  const token = githubTokenFromEnv(env)
  const gitEnv: GitCommandEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
  }

  if (!token) return gitEnv

  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64')
  gitEnv.GIT_CONFIG_COUNT = '1'
  gitEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
  gitEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${credentials}`
  return gitEnv
}

function formatGitError(message: string): string {
  if (!message.includes("could not read Username for 'https://github.com'")) return message
  return [
    message,
    'GitHub HTTPS authentication failed.',
    'Set GITHUB_TOKEN (or GH_TOKEN) for private GitHub repos, switch the repo URL to SSH, or remove private repos from KB_GIT_REPOS.',
  ].join('\n')
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: buildGitAuthEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => out.push(d))
    proc.stderr.on('data', (d: Buffer) => err.push(d))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8').trim())
      } else {
        const message = Buffer.concat(err).toString('utf8').trim() || `git exited ${code}`
        reject(new Error(formatGitError(message)))
      }
    })
    proc.on('error', reject)
  })
}

/** Blobless clone of `url` into `destDir`. Tracks `branch` when given, else the remote's
 *  own default branch (HEAD) — so repos on `master` (or anything else) clone correctly. */
export async function cloneRepo(url: string, destDir: string, branch?: string): Promise<void> {
  const args = ['clone', '--filter=blob:none', '--single-branch']
  if (branch) args.push('--branch', branch)
  args.push(url, destDir)
  await run('git', args, process.cwd())
}

/** Current branch name of a clone (e.g. `main`, `master`). */
export async function getCurrentBranch(repoDir: string): Promise<string> {
  return run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)
}

/** Discard kb's local `.kb` marker so ff-only pulls in hidden clones don't fail. */
async function clearKbMarkerForPull(repoDir: string): Promise<void> {
  try {
    await run('git', ['restore', '--', '.kb'], repoDir)
  } catch {
    // not tracked or nothing to restore
  }
  try {
    await run('git', ['clean', '-f', '--', '.kb'], repoDir)
  } catch {
    // ignore
  }
}

/** Pull latest commits in an already-cloned repo. Returns true if HEAD changed.
 *  Discards local modifications — session clones are managed mirrors, not workspaces. */
export async function pullRepo(repoDir: string): Promise<boolean> {
  await clearKbMarkerForPull(repoDir)
  const before = await getHeadSha(repoDir)
  await run('git', ['fetch'], repoDir)
  try {
    await run('git', ['reset', '--hard', '@{u}'], repoDir)
  } catch {
    const branch = await getCurrentBranch(repoDir)
    await run('git', ['reset', '--hard', `origin/${branch}`], repoDir)
  }
  try {
    await run('git', ['clean', '-fd'], repoDir)
  } catch {
    // ignore
  }
  const after = await getHeadSha(repoDir)
  return before !== after
}

/** Return the full SHA of HEAD in the given repo dir. */
export async function getHeadSha(repoDir: string): Promise<string> {
  return run('git', ['rev-parse', 'HEAD'], repoDir)
}

/** Derive a normalised base name from a git remote URL.
 *  Handles both https (https://github.com/org/repo.git) and ssh (git@github.com:org/repo.git).
 *  Shares the slug derivation with `repoSlugFromGitUrl` so base names and repo slugs agree.
 */
export function baseNameFromGitUrl(url: string): string {
  return repoSlugFromGitUrl(url)
}
