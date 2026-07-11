/**
 * `kb-server service install|uninstall|status` — register kb-server as a
 * user-level background service (launchd on macOS, systemd --user on Linux).
 *
 * This lives in compiled server source (not a repo `scripts/*.mjs`, which is not
 * shipped in the released binary) so tarball installs can actually use it. The
 * program path is resolved from the release layout (`~/.kb/bin/kb-server`) and
 * falls back to the running binary — never a repo dist path — and the unit is
 * actually loaded/enabled unless `--no-start` is passed.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getKbConfigDir } from '@kb/core/config/kb-config.js'
import { resolveReleaseInstallLayout } from '@kb/core/cli/release-uninstall.js'
import { logDir } from './daemon-cli.js'
import type { ServerLogger } from './server-cli.js'

const LAUNCHD_LABEL = 'com.kb.server'
const SYSTEMD_UNIT = 'kb-server.service'

/**
 * The command that launches the server, as argv. Prefer the release-installed
 * `~/.kb/bin/kb-server` launcher; otherwise re-launch the current runtime
 * (`execPath argv[1]`), which is correct for the compiled binary.
 */
function serverProgramArgs(): string[] {
  const layout = resolveReleaseInstallLayout()
  if (existsSync(layout.kbServerBinLink)) {
    return [layout.kbServerBinLink, 'start', '--with-mcp']
  }
  return [process.execPath, process.argv[1], 'start', '--with-mcp']
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}
function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT)
}

function run(cmd: string, args: string[]): { ok: boolean; message: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (result.error) return { ok: false, message: result.error.message }
  if ((result.status ?? 1) !== 0) {
    return { ok: false, message: (result.stderr || result.stdout || `exit ${result.status}`).trim() }
  }
  return { ok: true, message: (result.stdout || '').trim() }
}

// ─── macOS / launchd ──────────────────────────────────────────────────────────

async function installLaunchd(out: ServerLogger, start: boolean): Promise<void> {
  const p = plistPath()
  const out_ = path.join(logDir(), 'kb-server.out.log')
  const err_ = path.join(logDir(), 'kb-server.err.log')
  await mkdir(path.dirname(p), { recursive: true })
  await mkdir(logDir(), { recursive: true })

  const programArgs = serverProgramArgs()
  const argXml = programArgs.map(a => `    <string>${escapeXml(a)}</string>`).join('\n')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(out_)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(err_)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KB_HOME</key><string>${escapeXml(getKbConfigDir())}</string>
  </dict>
</dict>
</plist>
`
  await writeFile(p, plist, 'utf8')
  out.log(`✓ wrote ${p}`)
  warnSecrets(out)

  if (!start) {
    out.log(`Load it when ready:  launchctl load -w ${p}`)
    return
  }
  // Reload if already loaded, then load enabled.
  run('launchctl', ['unload', p])
  const loaded = run('launchctl', ['load', '-w', p])
  if (loaded.ok) out.log(`✓ launchd service ${LAUNCHD_LABEL} loaded (starts on login).`)
  else {
    out.error(`⚠  could not load the service automatically: ${loaded.message}`)
    out.error(`   Load it manually:  launchctl load -w ${p}`)
  }
}

async function uninstallLaunchd(out: ServerLogger): Promise<void> {
  const p = plistPath()
  if (!existsSync(p)) {
    out.log('launchd service not installed.')
    return
  }
  run('launchctl', ['unload', '-w', p])
  await rm(p, { force: true })
  out.log(`✓ removed launchd service ${LAUNCHD_LABEL}.`)
}

function statusLaunchd(out: ServerLogger): void {
  const p = plistPath()
  if (!existsSync(p)) {
    out.log('launchd service: not installed')
    return
  }
  const res = run('launchctl', ['list', LAUNCHD_LABEL])
  out.log(res.ok ? `launchd service: loaded\n${res.message}` : 'launchd service: installed, not loaded')
}

// ─── Linux / systemd --user ─────────────────────────────────────────────────

async function installSystemd(out: ServerLogger, start: boolean): Promise<void> {
  const p = systemdUnitPath()
  await mkdir(path.dirname(p), { recursive: true })
  // Double-quote every ExecStart arg so paths with spaces survive systemd's
  // word-splitting; escape backslashes and quotes per systemd's C-style rules.
  const execStart = serverProgramArgs().map(systemdQuote).join(' ')
  // Environment= values with spaces must be quoted as a single VAR=value token.
  const kbHomeEnv = systemdQuote(`KB_HOME=${getKbConfigDir()}`)
  const unit = `[Unit]
Description=KB knowledge base server (HTTP + MCP)
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
Environment=${kbHomeEnv}

[Install]
WantedBy=default.target
`
  await writeFile(p, unit, 'utf8')
  out.log(`✓ wrote ${p}`)
  warnSecrets(out)

  if (!start) {
    out.log('Enable it when ready:  systemctl --user enable --now kb-server.service')
    return
  }
  const reload = run('systemctl', ['--user', 'daemon-reload'])
  const enabled = run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT])
  if (reload.ok && enabled.ok) {
    out.log('✓ systemd --user service enabled and started (starts on login).')
    out.log('  (For boot-time start without login: `loginctl enable-linger $USER`.)')
  } else {
    out.error(`⚠  could not enable the service automatically: ${(enabled.message || reload.message).trim()}`)
    out.error('   Enable it manually:  systemctl --user enable --now kb-server.service')
  }
}

async function uninstallSystemd(out: ServerLogger): Promise<void> {
  const p = systemdUnitPath()
  if (!existsSync(p)) {
    out.log('systemd service not installed.')
    return
  }
  run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
  await rm(p, { force: true })
  run('systemctl', ['--user', 'daemon-reload'])
  out.log(`✓ removed systemd --user service ${SYSTEMD_UNIT}.`)
}

function statusSystemd(out: ServerLogger): void {
  const p = systemdUnitPath()
  if (!existsSync(p)) {
    out.log('systemd service: not installed')
    return
  }
  const res = run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT])
  out.log(`systemd service: installed, ${res.message || 'unknown'}`)
}

// ─── shared ───────────────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Quote a single systemd command/Environment token. systemd applies C-style
 * unescaping inside double quotes, so escape backslashes and double quotes and
 * wrap the whole token — this keeps paths with spaces (common on Linux home
 * dirs) and unusual characters intact.
 */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function warnSecrets(out: ServerLogger): void {
  out.log('  Note: set KB_SERVER_API_KEY and an LLM provider key in the service environment')
  out.log('  (a launchd EnvironmentVariables entry / a systemd drop-in) — the unit does not carry secrets.')
}

const SERVICE_USAGE = `Usage: kb-server service <install|uninstall|status> [--no-start]

  install [--no-start]   Register kb-server as a launchd/systemd --user service.
                         Loads/enables it immediately unless --no-start.
  uninstall              Unload and remove the service.
  status                 Show whether the service is installed and running.`

export async function runServiceCommand(args: string[], out: ServerLogger): Promise<void> {
  const sub = args[0]
  const noStart = args.includes('--no-start')
  const platform = process.platform

  if (sub === 'install') {
    if (platform === 'darwin') return installLaunchd(out, !noStart)
    if (platform === 'linux') return installSystemd(out, !noStart)
    out.error(`kb-server service is not supported on ${platform} yet.`)
    out.error('Run a background daemon instead:  kb-server start -d')
    process.exitCode = 1
    return
  }
  if (sub === 'uninstall') {
    if (platform === 'darwin') return uninstallLaunchd(out)
    if (platform === 'linux') return uninstallSystemd(out)
    out.error(`kb-server service is not supported on ${platform}.`)
    process.exitCode = 1
    return
  }
  if (sub === 'status') {
    if (platform === 'darwin') return statusLaunchd(out)
    if (platform === 'linux') return statusSystemd(out)
    out.log(`kb-server service: unsupported on ${platform}`)
    return
  }
  out.log(SERVICE_USAGE)
  if (sub && sub !== '--help' && sub !== '-h') process.exitCode = 1
}
