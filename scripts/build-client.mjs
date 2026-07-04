import { existsSync, readFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { copyCliRuntimeAssets, kbLauncherScript } from './cli-runtime-assets.mjs'
import { nodeBundleOptions } from './esbuild-node-bundle.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const pkgRoot = path.join(projectRoot, 'packages', 'kb-client')
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'))
const binDir = path.join(pkgRoot, 'dist', 'bin')
const outFile = path.join(binDir, 'kb.js')
const launcherFile = path.join(binDir, 'kb')

await mkdir(binDir, { recursive: true })

await build(
  nodeBundleOptions({
    entryPoints: [path.join(pkgRoot, 'src', 'cli', 'index.ts')],
    outfile: outFile,
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: {
      __KB_VERSION__: JSON.stringify(version),
    },
  }),
)

if (process.platform !== 'win32') {
  await chmod(outFile, 0o755)
}

await writeFile(launcherFile, kbLauncherScript({ jsBasename: 'kb.js' }), 'utf8')
if (process.platform !== 'win32') await chmod(launcherFile, 0o755)

await copyCliRuntimeAssets(projectRoot, binDir)

console.log('→ packages/kb-client/dist/bin/kb')
