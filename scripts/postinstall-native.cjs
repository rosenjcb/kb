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

spawnSync('npm', ['rebuild', dep], {
  cwd: rootDir,
  stdio: 'ignore',
  env: process.env,
})

if (canLoadNativeRuntime()) {
  process.exit(0)
}

console.warn('KB installed, but its native runtime still needs setup for this machine.')
console.warn('The first `kb` launch will try to finish that automatically.')
