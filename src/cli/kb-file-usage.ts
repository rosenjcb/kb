import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findKbFileInfo } from './kb-file'

/**
 * Tracks how many times `kb` has been run in each directory so we can passively
 * suggest scaffolding a `.kb` file once a directory is clearly in regular use.
 */

/** Runs in a directory before we surface the "create a .kb file" suggestion. */
const NUDGE_THRESHOLD = 3

interface DirUsage {
  runs: number
  nudged: boolean
}

interface UsageFile {
  version: 1
  dirs: Record<string, DirUsage>
}

function kbHomeDir(): string {
  const override = process.env.KB_HOME?.trim()
  return override ? path.resolve(override) : path.join(os.homedir(), '.kb')
}

function usageFilePath(): string {
  return path.join(kbHomeDir(), 'dir-usage.json')
}

async function readUsage(): Promise<UsageFile> {
  try {
    const parsed = JSON.parse(await readFile(usageFilePath(), 'utf8')) as Partial<UsageFile>
    if (parsed && typeof parsed === 'object' && parsed.dirs && typeof parsed.dirs === 'object') {
      return { version: 1, dirs: parsed.dirs as Record<string, DirUsage> }
    }
  } catch {
    // Missing or corrupt — start fresh.
  }
  return { version: 1, dirs: {} }
}

async function writeUsage(usage: UsageFile): Promise<void> {
  await mkdir(kbHomeDir(), { recursive: true })
  await writeFile(usageFilePath(), `${JSON.stringify(usage, null, 2)}\n`, 'utf8')
}

/**
 * Record a `kb` run in `cwd` and return a one-time suggestion to create a `.kb`
 * file once the directory has been used {@link NUDGE_THRESHOLD} times without
 * one. Returns null when a `.kb` file already governs the directory, the
 * threshold has not been reached, or the suggestion was already shown.
 *
 * Failures are swallowed — usage tracking must never block a command.
 */
export async function recordKbDirRun(cwd: string): Promise<string | null> {
  try {
    // Already governed by a `.kb` file — nothing to suggest.
    if (await findKbFileInfo(cwd)) return null

    const key = path.resolve(cwd)
    const usage = await readUsage()
    const entry = usage.dirs[key] ?? { runs: 0, nudged: false }
    entry.runs += 1

    let tip: string | null = null
    if (!entry.nudged && entry.runs >= NUDGE_THRESHOLD) {
      entry.nudged = true
      tip = [
        '💡 You run kb here often. Create a `.kb` file to pin this directory to a base',
        '   and control what init/scan pick up:  kb ignore init',
      ].join('\n')
    }

    usage.dirs[key] = entry
    await writeUsage(usage)
    return tip
  } catch {
    return null
  }
}
