import { access, lstat, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getKbConfigFile } from '@kb/core/config/kb-config.js'
import { defaultLogsDir } from '@kb/core/core/telemetry.js'
import { getKbHomeDir } from '@kb/core/storage/base-selection.js'

export interface ReleaseInstallLayout {
  kbHome: string
  binDir: string
  kbBinLink: string
  kbServerBinLink: string
  clientRuntimeDir: string
  serverRuntimeDir: string
  legacyClientModulesDir: string
  kbPythonDir: string
}

export interface UninstallLogger {
  log(message: string): void
  error(message: string): void
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function lexists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

/** Resolve release-install paths under `KB_INSTALL_ROOT` / `~/.kb`. */
export function resolveReleaseInstallLayout(
  kbHome = process.env.KB_INSTALL_ROOT ?? path.join(os.homedir(), '.kb')
): ReleaseInstallLayout {
  const binDir = path.join(kbHome, 'bin')
  return {
    kbHome,
    binDir,
    kbBinLink: path.join(binDir, 'kb'),
    kbServerBinLink: path.join(binDir, 'kb-server'),
    clientRuntimeDir: path.join(kbHome, 'runtime', 'client'),
    serverRuntimeDir: path.join(kbHome, 'runtime', 'server'),
    legacyClientModulesDir: path.join(kbHome, 'runtime', 'node_modules'),
    kbPythonDir: path.join(kbHome, '.kb-python'),
  }
}

/** Server-owned paths under KB_HOME (indexes, config, run reports). */
export function resolveServerDataPaths(kbHome = getKbHomeDir()) {
  return {
    kbHome,
    configFile: getKbConfigFile(),
    sessionsDir: path.join(kbHome, 'sessions'),
    logsDir: defaultLogsDir(),
    tracesDir: path.join(kbHome, 'traces'),
    legacySessionFile: path.join(kbHome, 'session.json'),
  }
}

export async function removePathFromRcFiles(kbBinDir: string): Promise<string[]> {
  const rcFiles = [
    path.join(os.homedir(), '.bashrc'),
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.profile'),
  ]
  const patterns = [
    `export PATH="${kbBinDir}:$PATH"`,
    'export PATH="$HOME/.kb/bin:$PATH"',
  ]
  const modified: string[] = []
  for (const rc of rcFiles) {
    if (!(await exists(rc))) continue
    const content = await readFile(rc, 'utf8')
    const lines = content.split('\n')
    const filtered = lines.filter(line => !patterns.includes(line.trim()))
    if (filtered.length !== lines.length) {
      await writeFile(rc, filtered.join('\n'), 'utf8')
      modified.push(rc)
    }
  }
  return modified
}

async function maybeRemovePathFromRc(layout: ReleaseInstallLayout): Promise<string[]> {
  const kbLeft = await lexists(layout.kbBinLink)
  const serverLeft = await lexists(layout.kbServerBinLink)
  if (kbLeft || serverLeft) return []
  return removePathFromRcFiles(layout.binDir)
}

/**
 * Remove the release-installed **client** only (`kb` binary + client runtime).
 * Does not touch kb-server or server data under ~/.kb.
 */
export async function performClientUninstall(out: UninstallLogger): Promise<void> {
  const layout = resolveReleaseInstallLayout()

  if (await lexists(layout.kbBinLink)) {
    await unlink(layout.kbBinLink)
    out.log(`Removed: ${layout.kbBinLink}`)
  }

  if (await exists(layout.clientRuntimeDir)) {
    await rm(layout.clientRuntimeDir, { recursive: true, force: true })
    out.log(`Removed: ${layout.clientRuntimeDir}`)
  }

  if (await exists(layout.legacyClientModulesDir)) {
    await rm(layout.legacyClientModulesDir, { recursive: true, force: true })
    out.log(`Removed: ${layout.legacyClientModulesDir}`)
  }

  if (await exists(layout.kbPythonDir)) {
    await rm(layout.kbPythonDir, { recursive: true, force: true })
    out.log(`Removed: ${layout.kbPythonDir}`)
  }

  for (const rc of await maybeRemovePathFromRc(layout)) {
    out.log(`Removed PATH entry from: ${rc}`)
  }
}

/**
 * Remove the release-installed **server** (`kb-server` binary + server runtime).
 * With `--purge`, also deletes server-owned data (sessions, config, logs, traces).
 */
export async function performServerUninstall(
  opts: { purge: boolean },
  out: UninstallLogger
): Promise<void> {
  const layout = resolveReleaseInstallLayout()

  if (await lexists(layout.kbServerBinLink)) {
    await unlink(layout.kbServerBinLink)
    out.log(`Removed: ${layout.kbServerBinLink}`)
  }

  if (await exists(layout.serverRuntimeDir)) {
    await rm(layout.serverRuntimeDir, { recursive: true, force: true })
    out.log(`Removed: ${layout.serverRuntimeDir}`)
  }

  if (opts.purge) {
    const data = resolveServerDataPaths(layout.kbHome)
    for (const target of [
      data.configFile,
      data.legacySessionFile,
      data.sessionsDir,
      data.logsDir,
      data.tracesDir,
    ]) {
      if (!(await exists(target))) continue
      await rm(target, { recursive: true, force: true })
      out.log(`Removed: ${target}`)
    }
  }

  for (const rc of await maybeRemovePathFromRc(layout)) {
    out.log(`Removed PATH entry from: ${rc}`)
  }
}
