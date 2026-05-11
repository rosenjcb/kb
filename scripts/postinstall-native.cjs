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

console.warn('Native bindings for better-sqlite3 not found — rebuilding for current Node version...')

const depDir = path.join(rootDir, 'node_modules', dep)
const rebuild = spawnSync('npm', ['rebuild', dep], {
  cwd: rootDir,
  stdio: 'inherit',
  env: process.env,
  shell: true,
})

if (rebuild.status !== 0) {
  const npx = spawnSync('npx', ['node-gyp', 'rebuild'], {
    cwd: depDir,
    stdio: 'inherit',
    env: process.env,
    shell: true,
  })
  if (npx.status !== 0) {
    console.error('Failed to rebuild better-sqlite3. Ensure build tools (python3, make, g++) are installed.')
    process.exit(1)
  }
}

if (canLoadNativeRuntime()) {
  console.log('better-sqlite3 rebuilt successfully.')
  process.exit(0)
}

console.error('Rebuild completed but better-sqlite3 still cannot load. Check your Node.js version and build tools.')
process.exit(1)
