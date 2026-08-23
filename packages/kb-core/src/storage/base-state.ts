/**
 * Line-file state under `$KB_HOME/state/`.
 *
 * `active-base` is the **client's** chosen base (`kb base use`, or `KB_ACTIVE_BASE`),
 * sent as `X-KB-Base`. It lives under `$KB_HOME` only because that's where client
 * state already lives — it is written only by the `kb` client, read only by the `kb`
 * client. The server has no analogous file: it never records a default base. See the
 * "Two separate base concepts" note in `resolveServerBaseDir`
 * (`@kb/server/server-cli.js`) for why that split matters.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
