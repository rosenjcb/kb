#!/usr/bin/env node
/**
 * Install kb-server as a user-level background service (launchd on macOS, systemd on Linux).
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const serverBin = path.join(repoRoot, 'packages/kb-server/dist/bin/kb-server')

async function main() {
  const platform = process.platform
  if (platform === 'darwin') {
    await installLaunchd()
    return
  }
  if (platform === 'linux') {
    await installSystemdUser()
    return
  }
  console.error(`kb-server install is not supported on ${platform} yet.`)
  console.error('Start manually: kb-server start')
  process.exit(1)
}

async function installLaunchd() {
  const label = 'com.kb.server'
  const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)
  const logDir = path.join(os.homedir(), '.kb', 'logs')
  await mkdir(logDir, { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${serverBin}</string>
    <string>start</string>
    <string>--with-mcp</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logDir, 'kb-server.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'kb-server.err.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KB_HOME</key><string>${path.join(os.homedir(), '.kb')}</string>
  </dict>
</dict>
</plist>`
  await writeFile(plistPath, plist, 'utf8')
  console.log(`Wrote ${plistPath}`)
  console.log(`Load with: launchctl load ${plistPath}`)
  console.log(`Stop with: launchctl unload ${plistPath}`)
}

async function installSystemdUser() {
  const unitDir = path.join(os.homedir(), '.config/systemd/user')
  await mkdir(unitDir, { recursive: true })
  const unitPath = path.join(unitDir, 'kb-server.service')
  const unit = `[Unit]
Description=KB knowledge base server
After=network.target

[Service]
ExecStart=${serverBin} start --with-mcp
Restart=on-failure
Environment=KB_HOME=${path.join(os.homedir(), '.kb')}

[Install]
WantedBy=default.target
`
  await writeFile(unitPath, unit, 'utf8')
  console.log(`Wrote ${unitPath}`)
  console.log('Enable with: systemctl --user enable --now kb-server.service')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
