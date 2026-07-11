import { readFileSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const projectRoot = path.resolve(import.meta.dirname, '..')
const rootNodeModules = path.join(projectRoot, 'node_modules')

const runtimeDeps = [
  '@ast-grep/napi',
  '@coderabbitai/ast-grep-langs',
  '@huggingface/transformers',
  'web-tree-sitter',
  'tree-sitter-bash',
  'tree-sitter-c',
  'tree-sitter-c-sharp',
  'tree-sitter-cpp',
  'tree-sitter-css',
  'tree-sitter-go',
  'tree-sitter-haskell',
  'tree-sitter-html',
  'tree-sitter-java',
  'tree-sitter-javascript',
  'tree-sitter-php',
  'tree-sitter-python',
  'tree-sitter-ruby',
  'tree-sitter-rust',
  'tree-sitter-scala',
  'tree-sitter-typescript',
]

const targets = {
  client: {
    archiveName: 'kb-client-node24.tgz',
    packageDir: path.join(projectRoot, 'packages', 'kb-client'),
    packageName: '@kb/client',
  },
  server: {
    archiveName: 'kb-server-node24.tgz',
    packageDir: path.join(projectRoot, 'packages', 'kb-server'),
    packageName: '@kb/server',
  },
}

const targetName = process.argv[2]
const outputDirArg = process.argv[3] ?? '.'

if (targetName !== 'client' && targetName !== 'server') {
  console.error('Usage: node scripts/build-release-runtime.mjs <client|server> [outputDir]')
  process.exit(1)
}

const target = targets[targetName]
const outputDir = path.resolve(projectRoot, outputDirArg)
const stagingRoot = path.join(projectRoot, '.tmp', 'release-runtime', targetName)
const packageJsonPath = path.join(target.packageDir, 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const binDir = path.join(target.packageDir, 'dist', 'bin')
const archivePath = path.join(outputDir, target.archiveName)
const stagingNodeModules = path.join(stagingRoot, 'node_modules')

async function copyRuntimeDependency(packageName) {
  const source = path.join(rootNodeModules, packageName)
  const destination = path.join(stagingNodeModules, packageName)
  await cp(source, destination, { dereference: true, recursive: true, force: true })
}

await rm(stagingRoot, { force: true, recursive: true })
await mkdir(path.join(stagingRoot, 'bin'), { recursive: true })
await mkdir(stagingNodeModules, { recursive: true })
await mkdir(outputDir, { recursive: true })

await cp(binDir, path.join(stagingRoot, 'bin'), { recursive: true })
for (const packageName of runtimeDeps) {
  try {
    await copyRuntimeDependency(packageName)
  } catch (error) {
    if (packageName === '@huggingface/transformers') continue
    throw error
  }
}
await writeFile(
  path.join(stagingRoot, 'release.json'),
  JSON.stringify(
    {
      name: target.packageName,
      version: packageJson.version,
      node: 24,
    },
    null,
    2,
  ),
  'utf8',
)

await execFileAsync('tar', ['-czf', archivePath, '-C', stagingRoot, '.'], {
  cwd: projectRoot,
})

console.log(`→ ${path.relative(projectRoot, archivePath)}`)
