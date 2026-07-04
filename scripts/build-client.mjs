import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const projectRoot = path.resolve(import.meta.dirname, '..')
const pkgRoot = path.join(projectRoot, 'packages', 'kb-client')
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'))
const binDir = path.join(pkgRoot, 'dist', 'bin')
const outFile = path.join(binDir, 'kb.js')
const launcherFile = path.join(binDir, 'kb')

await mkdir(binDir, { recursive: true })

await build({
  entryPoints: [path.join(pkgRoot, 'src', 'cli', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  packages: 'external',
  jsx: 'automatic',
  jsxImportSource: 'react',
  define: {
    __KB_VERSION__: JSON.stringify(version),
  },
})

if (process.platform !== 'win32') {
  await chmod(outFile, 0o755)
}

const pinnedMajor = '24'
const launcher = `#!/usr/bin/env bash
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
KB_NODE=""
NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
if [ -d "$NVM_DIR/versions/node" ]; then
  KB_NODE="$(ls -d "$NVM_DIR/versions/node/v${pinnedMajor}."*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$KB_NODE" ]; then
  KB_NODE="$(command -v node)"
fi
exec "$KB_NODE" --no-warnings "$SCRIPT_DIR/kb.js" "$@"
`
await writeFile(launcherFile, launcher, 'utf8')
if (process.platform !== 'win32') await chmod(launcherFile, 0o755)

const promptsSrc = path.join(projectRoot, 'packages', 'kb-core', 'src', 'prompts')
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

const skillsRoot = path.join(projectRoot, 'skills')
if (existsSync(skillsRoot)) {
  for (const skillName of await readdir(skillsRoot)) {
    const skillFile = path.join(skillsRoot, skillName, 'SKILL.md')
    if (existsSync(skillFile)) {
      await copyFile(skillFile, path.join(path.dirname(outFile), `${skillName}.skill.md`))
    }
  }
}

console.log('→ packages/kb-client/dist/bin/kb')
