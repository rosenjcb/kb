import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const projectRoot = process.cwd()
const binDir = path.join(projectRoot, 'dist', 'bin')
const outFile = path.join(binDir, 'kb.js')
const launcherFile = path.join(binDir, 'kb')
const nativePreflightFile = path.join(binDir, 'native-preflight.cjs')

await mkdir(binDir, { recursive: true })

await build({
  entryPoints: [path.join(projectRoot, 'src', 'cli', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  packages: 'external',
  jsx: 'automatic',
  jsxImportSource: 'react',
})

if (process.platform !== 'win32') {
  await chmod(outFile, 0o755)
}

const pinnedMajor = '22'
const nativePreflight = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const dep = 'better-sqlite3'
const scriptDir = __dirname
const currentNodeVersion = process.version

function canLoadNativeRuntime() {
  const probe = spawnSync(process.execPath, ['-e', \`require(\${JSON.stringify(dep)})\`], {
    cwd: scriptDir,
    stdio: 'ignore',
    env: process.env,
  })
  return probe.status === 0
}

if (canLoadNativeRuntime()) process.exit(0)

// Check if Node version matches expected
const currentMajor = parseInt(process.version.slice(1).split('.')[0], 10)
const expectedMajor = ${pinnedMajor}

console.error('❌ KB native module failed to load.')
console.error('')
console.error('Current Node:  ' + currentNodeVersion)
console.error('Expected Node: v${pinnedMajor}.x.x')
console.error('')

if (currentMajor !== expectedMajor) {
  console.error('Node version mismatch detected!')
  console.error('better-sqlite3 was compiled for Node ${pinnedMajor}.')
  console.error('')
  console.error('Fix with nvm:')
  console.error('  nvm install ${pinnedMajor}')
  console.error('  nvm use ${pinnedMajor}')
  console.error('  nvm alias default ${pinnedMajor}')
} else {
  console.error('Try reinstalling KB:')
  console.error('  pnpm remove -g kb')
  console.error('  pnpm add -g https://github.com/rosenjcb/kb/releases/latest/download/kb-cli-node22.tgz')
}
process.exit(1)`

const launcher = `#!/usr/bin/env bash
# Resolve the Node version pinned by this project (.nvmrc = ${pinnedMajor}).
# This avoids ABI mismatch when the shell's active Node differs from the
# version better-sqlite3 was compiled against.
SOURCE="\$0"
while [ -L "\$SOURCE" ]; do
  DIR="$(cd "$(dirname "\$SOURCE")" && pwd)"
  SOURCE="$(readlink "\$SOURCE")"
  [[ "\$SOURCE" != /* ]] && SOURCE="\$DIR/\$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "\$SOURCE")" && pwd)"
KB_NODE=""
NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
if [ -d "\$NVM_DIR/versions/node" ]; then
  KB_NODE="$(ls -d "\$NVM_DIR/versions/node/v${pinnedMajor}."*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "\$KB_NODE" ]; then
  KB_NODE="$(command -v node)"
fi
"\$KB_NODE" "\$SCRIPT_DIR/native-preflight.cjs" || exit \$?
exec "\$KB_NODE" "\$SCRIPT_DIR/kb.js" "\$@"
`

await writeFile(launcherFile, launcher, 'utf8')
await writeFile(nativePreflightFile, nativePreflight, 'utf8')

if (process.platform !== 'win32') {
  await chmod(launcherFile, 0o755)
  await chmod(nativePreflightFile, 0o755)
}

// Copy prompt .md files so the bundled binary can resolve them at runtime (see src/prompts/prompt-assets.ts).
const promptsSrc = path.join(projectRoot, 'src', 'prompts')
const promptsDest = path.dirname(outFile)
for (const file of await readdir(promptsSrc)) {
  if (file.endsWith('.md')) {
    await copyFile(path.join(promptsSrc, file), path.join(promptsDest, file))
  }
}

const docQuestionnairesSrc = path.join(promptsSrc, 'doc-questionnaires')
const docQuestionnairesDest = path.join(promptsDest, 'doc-questionnaires')
if (existsSync(docQuestionnairesSrc)) {
  await mkdir(docQuestionnairesDest, { recursive: true })
  for (const file of await readdir(docQuestionnairesSrc)) {
    if (file.endsWith('.md')) {
      await copyFile(path.join(docQuestionnairesSrc, file), path.join(docQuestionnairesDest, file))
    }
  }
}

// Copy skill SKILL.md files so the bundled binary can resolve them at runtime.
// skills/<name>/SKILL.md → dist/bin/<name>.skill.md
const skillsRoot = path.join(projectRoot, 'skills')
if (existsSync(skillsRoot)) {
  for (const skillName of await readdir(skillsRoot)) {
    const skillFile = path.join(skillsRoot, skillName, 'SKILL.md')
    if (existsSync(skillFile)) {
      await copyFile(skillFile, path.join(path.dirname(outFile), `${skillName}.skill.md`))
    }
  }
}
