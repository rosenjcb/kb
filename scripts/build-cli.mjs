import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const projectRoot = process.cwd()
const binDir = path.join(projectRoot, 'dist', 'bin')
const outFile = path.join(binDir, 'kb.js')
const launcherFile = path.join(binDir, 'kb')

await mkdir(binDir, { recursive: true })

await build({
  entryPoints: [path.join(projectRoot, 'src', 'cli', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  packages: 'external',
  jsx: 'automatic',
  jsxImportSource: 'react',
})

if (process.platform !== 'win32') {
  await chmod(outFile, 0o755)
}

const launcher = `#!/usr/bin/env node
import './kb.js'
`

await writeFile(launcherFile, launcher, 'utf8')

if (process.platform !== 'win32') {
  await chmod(launcherFile, 0o755)
}

// Copy prompt .md files so the bundled binary can resolve them at runtime.
const promptsSrc = path.join(projectRoot, 'src', 'prompts')
const promptsDest = path.dirname(outFile)
for (const file of await readdir(promptsSrc)) {
  if (file.endsWith('.md')) {
    await copyFile(path.join(promptsSrc, file), path.join(promptsDest, file))
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
