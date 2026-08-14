import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = 'state'
const ACTIVE_BASE_FILE = 'active-base'

function kbHomeDir(): string {
  const override = process.env.KB_HOME?.trim()
  return override ? path.resolve(override) : path.join(os.homedir(), '.kb')
}

function statePath(name: string): string {
  return path.join(kbHomeDir(), STATE_DIR, name)
}

async function readLineFile(name: string): Promise<string | undefined> {
  try {
    const value = (await readFile(statePath(name), 'utf8')).trim()
    return value || undefined
  } catch {
    return undefined
  }
}

async function writeLineFile(name: string, value: string): Promise<void> {
  await mkdir(path.join(kbHomeDir(), STATE_DIR), { recursive: true })
  await writeFile(statePath(name), `${value.trim()}\n`, 'utf8')
}

export async function readActiveBaseName(): Promise<string | undefined> {
  return process.env.KB_ACTIVE_BASE?.trim() || (await readLineFile(ACTIVE_BASE_FILE))
}

export async function writeActiveBaseName(base: string): Promise<void> {
  await writeLineFile(ACTIVE_BASE_FILE, base)
}

/** One-time migration of the removed config.json active base into the state file. */
export async function migrateLegacyConfigJsonBases(
  legacy: { activeBase?: string }
): Promise<void> {
  const configPath = path.join(kbHomeDir(), 'config.json')
  const legacyActivePath = path.join(kbHomeDir(), 'active-base')
  // The persistent client default base was removed — the server owns the default now.
  // Drop any leftover default-base state so it can never silently override the active base.
  const legacyDefaultPath = path.join(kbHomeDir(), 'default-base')
  const stateDefaultPath = statePath('default-base')

  if (legacy.activeBase && !(await readLineFile(ACTIVE_BASE_FILE))) {
    await writeActiveBaseName(legacy.activeBase)
  }

  // Migrate the flat active-base file from earlier env-only rollout.
  try {
    const flatActive = (await readFile(legacyActivePath, 'utf8')).trim()
    if (flatActive && !(await readLineFile(ACTIVE_BASE_FILE))) {
      await writeActiveBaseName(flatActive)
    }
  } catch {
    // no flat file
  }

  await rm(configPath, { force: true })
  await rm(legacyActivePath, { force: true })
  await rm(legacyDefaultPath, { force: true })
  await rm(stateDefaultPath, { force: true })
}
