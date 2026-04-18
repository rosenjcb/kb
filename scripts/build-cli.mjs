import { chmod, copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const projectRoot = process.cwd()
const outFile = path.join(projectRoot, 'dist', 'bin', 'kb.js')

await mkdir(path.dirname(outFile), { recursive: true })

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

// Copy prompt .md files so the bundled binary can resolve them at runtime.
const promptsSrc = path.join(projectRoot, 'src', 'prompts')
const promptsDest = path.dirname(outFile)
for (const file of await readdir(promptsSrc)) {
  if (file.endsWith('.md')) {
    await copyFile(path.join(promptsSrc, file), path.join(promptsDest, file))
  }
}

console.log(`Built CLI executable: ${outFile}`)
