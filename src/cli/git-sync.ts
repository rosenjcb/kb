import { spawn } from 'node:child_process'

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => out.push(d))
    proc.stderr.on('data', (d: Buffer) => err.push(d))
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8').trim())
      } else {
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git exited ${code}`))
      }
    })
    proc.on('error', reject)
  })
}

/** Blobless clone of `url` at `branch` into `destDir`. */
export async function cloneRepo(url: string, destDir: string, branch: string): Promise<void> {
  await run('git', ['clone', '--filter=blob:none', '--branch', branch, '--single-branch', url, destDir], process.cwd())
}

/** Pull latest commits in an already-cloned repo. Returns true if there were new commits. */
export async function pullRepo(repoDir: string): Promise<boolean> {
  const before = await getHeadSha(repoDir)
  await run('git', ['pull', '--ff-only'], repoDir)
  const after = await getHeadSha(repoDir)
  return before !== after
}

/** Return the full SHA of HEAD in the given repo dir. */
export async function getHeadSha(repoDir: string): Promise<string> {
  return run('git', ['rev-parse', 'HEAD'], repoDir)
}

/** Derive a normalised base name from a git remote URL.
 *  Handles both https (https://github.com/org/repo.git) and ssh (git@github.com:org/repo.git).
 */
export function baseNameFromGitUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '')
  // Extract the org/repo path component regardless of protocol
  const pathPart = cleaned.includes('://')
    ? cleaned.split('/').slice(3).join('/')   // https://host/org/repo → org/repo
    : (cleaned.split(':')[1] ?? cleaned)       // git@host:org/repo → org/repo
  const parts = pathPart.split('/')
  const org = parts.at(-2) ?? 'unknown'
  const repo = parts.at(-1) ?? 'repo'
  return `${org}-${repo}`.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()
}
