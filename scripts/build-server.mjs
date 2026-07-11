import { readFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { copyCliRuntimeAssets, kbLauncherScript } from './cli-runtime-assets.mjs'
import { nodeBundleOptions } from './esbuild-node-bundle.mjs'

const projectRoot = path.resolve(import.meta.dirname, '..')
const pkgRoot = path.join(projectRoot, 'packages', 'kb-server')
const corePkgRoot = path.join(projectRoot, 'packages', 'kb-core')
const { version } = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'))
const { version: coreVersion } = JSON.parse(
  readFileSync(path.join(corePkgRoot, 'package.json'), 'utf-8')
)
const binDir = path.join(pkgRoot, 'dist', 'bin')
const outFile = path.join(binDir, 'kb-server.js')
const launcherFile = path.join(binDir, 'kb-server')

await mkdir(binDir, { recursive: true })

await build(
  nodeBundleOptions({
    entryPoints: [path.join(pkgRoot, 'src', 'index.ts')],
    outfile: outFile,
    define: {
      __KB_SERVER_VERSION__: JSON.stringify(version),
      // Internal: snapshot manifest `producer.coreVersion` via `@kb/core/version`.
      __KB_VERSION__: JSON.stringify(coreVersion),
    },
  }),
)

if (process.platform !== 'win32') {
  await chmod(outFile, 0o755)
}

await writeFile(launcherFile, kbLauncherScript({ jsBasename: 'kb-server.js' }), 'utf8')
if (process.platform !== 'win32') await chmod(launcherFile, 0o755)

await copyCliRuntimeAssets(projectRoot, binDir)

console.log('→ packages/kb-server/dist/bin/kb-server')
