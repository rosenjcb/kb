#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const dep = 'better-sqlite3'
const rootDir = path.resolve(__dirname, '..')

function canLoadNativeRuntime() {
  const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dep)})`], {
    cwd: rootDir,
    stdio: 'ignore',
    env: process.env,
  })
  return probe.status === 0
}

if (canLoadNativeRuntime()) {
  process.exit(0)
}

// Check if we're in a global pnpm context by looking for the telltale path structure
const isGlobalPnpm = process.env.npm_config_prefix?.includes('.kb/pnpm-global') || 
                     process.env.npm_config_user_agent?.includes('pnpm') &&
                     rootDir.includes('.pnpm-global')

if (isGlobalPnpm) {
  console.warn('KB installed globally, but native bindings are missing.')
  console.warn('Please reinstall with: pnpm add -g --force https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node22.tgz')
  process.exit(1)
}

console.warn('KB installed, but its native runtime still needs setup for this machine.')
console.warn('The first `kb` launch will try to finish that automatically.')

if (canLoadNativeRuntime()) {
  process.exit(0)
}

console.warn('KB installed, but its native runtime still needs setup for this machine.')
console.warn('The first `kb` launch will try to finish that automatically.')
