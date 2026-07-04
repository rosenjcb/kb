/**
 * Fix imports after kb-core module relocation.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, acc)
    else if (/\.(ts|tsx|md)$/.test(name)) acc.push(abs)
  }
  return acc
}

const REPLACEMENTS = [
  // old client cli paths -> kb-core paths
  ['@kb/client/cli/kb-config.js', '@kb/core/config/kb-config.js'],
  ['@kb/client/cli/base-selection.js', '@kb/core/storage/base-selection.js'],
  ['@kb/client/cli/base-meta.js', '@kb/core/storage/base-meta.js'],
  ['@kb/client/cli/auto-sync.js', '@kb/core/ops/auto-sync.js'],
  ['@kb/client/cli/git-sync.js', '@kb/core/ops/git-sync.js'],
  ['@kb/client/cli/init-cli.js', '@kb/core/ops/init-cli.js'],
  ['@kb/client/cli/scan-command.js', '@kb/core/ops/scan-command.js'],
  ['@kb/client/cli/init-source-files-manifest.js', '@kb/core/ops/init-source-files-manifest.js'],
  ['@kb/client/cli/init-ast-files-manifest.js', '@kb/core/ops/init-ast-files-manifest.js'],
  ['@kb/client/cli/init-source-snapshots.js', '@kb/core/ops/init-source-snapshots.js'],
  ['@kb/client/cli/init-topic-coverage.js', '@kb/core/ops/init-topic-coverage.js'],
  ['@kb/client/cli/intent-cli.js', '@kb/core/query/intent-cli.js'],
  ['@kb/client/cli/query-truth-retrieval.js', '@kb/core/query/query-truth-retrieval.js'],
  ['@kb/client/cli/retrieval-fallback.js', '@kb/core/query/retrieval-fallback.js'],
  // old server service paths -> kb-core
  ['@kb/server/kb-service.js', '@kb/core/service/kb-service.js'],
  ['@kb/server/query-pipeline.js', '@kb/core/service/query-pipeline.js'],
  ['@kb/server/serialize.js', '@kb/core/service/serialize.js'],
  // relative cli imports in client package
  ["from '../cli/kb-config.js'", "from '@kb/core/config/kb-config.js'"],
  ["from '../cli/kb-config'", "from '@kb/core/config/kb-config.js'"],
  ["from '../cli/base-selection.js'", "from '@kb/core/storage/base-selection.js'"],
  ["from '../cli/base-selection'", "from '@kb/core/storage/base-selection.js'"],
  ["from '../cli/base-meta.js'", "from '@kb/core/storage/base-meta.js'"],
  ["from '../cli/base-meta'", "from '@kb/core/storage/base-meta.js'"],
  ["from '../cli/init-cli.js'", "from '@kb/core/ops/init-cli.js'"],
  ["from '../cli/init-cli'", "from '@kb/core/ops/init-cli.js'"],
  ["from '../cli/scan-command.js'", "from '@kb/core/ops/scan-command.js'"],
  ["from '../cli/scan-command'", "from '@kb/core/ops/scan-command.js'"],
  ["from '../cli/auto-sync.js'", "from '@kb/core/ops/auto-sync.js'"],
  ["from '../cli/auto-sync'", "from '@kb/core/ops/auto-sync.js'"],
  ["from '../cli/git-sync.js'", "from '@kb/core/ops/git-sync.js'"],
  ["from '../cli/git-sync'", "from '@kb/core/ops/git-sync.js'"],
  ["from '../cli/intent-cli.js'", "from '@kb/core/query/intent-cli.js'"],
  ["from '../cli/intent-cli'", "from '@kb/core/query/intent-cli.js'"],
  ["from '../cli/query-truth-retrieval.js'", "from '@kb/core/query/query-truth-retrieval.js'"],
  ["from '../cli/query-truth-retrieval'", "from '@kb/core/query/query-truth-retrieval.js'"],
  ["from '../cli/retrieval-fallback.js'", "from '@kb/core/query/retrieval-fallback.js'"],
  ["from '../cli/retrieval-fallback'", "from '@kb/core/query/retrieval-fallback.js'"],
  ["from '../cli/init-source-files-manifest.js'", "from '@kb/core/ops/init-source-files-manifest.js'"],
  ["from '../cli/init-source-snapshots.js'", "from '@kb/core/ops/init-source-snapshots.js'"],
  ["from '../cli/init-topic-coverage.js'", "from '@kb/core/ops/init-topic-coverage.js'"],
  ["from '../cli/init-ast-files-manifest.js'", "from '@kb/core/ops/init-ast-files-manifest.js'"],
  ["from './kb-config.js'", "from '@kb/core/config/kb-config.js'"],
  ["from './kb-config'", "from '@kb/core/config/kb-config.js'"],
  ["from './base-selection.js'", "from '@kb/core/storage/base-selection.js'"],
  ["from './base-meta.js'", "from '@kb/core/storage/base-meta.js'"],
  ["from './init-cli.js'", "from '@kb/core/ops/init-cli.js'"],
  ["from './scan-command.js'", "from '@kb/core/ops/scan-command.js'"],
  ["from './auto-sync.js'", "from '@kb/core/ops/auto-sync.js'"],
  ["from './git-sync.js'", "from '@kb/core/ops/git-sync.js'"],
  ["from './intent-cli.js'", "from '@kb/core/query/intent-cli.js'"],
  ["from './query-truth-retrieval.js'", "from '@kb/core/query/query-truth-retrieval.js'"],
  ["from './retrieval-fallback.js'", "from '@kb/core/query/retrieval-fallback.js'"],
  ["from './init-source-files-manifest.js'", "from '@kb/core/ops/init-source-files-manifest.js'"],
  ["from './init-source-snapshots.js'", "from '@kb/core/ops/init-source-snapshots.js'"],
  ["from './init-topic-coverage.js'", "from '@kb/core/ops/init-topic-coverage.js'"],
  ["from './init-ast-files-manifest.js'", "from '@kb/core/ops/init-ast-files-manifest.js'"],
  // server service imports
  ["from './kb-service.js'", "from '@kb/core/service/kb-service.js'"],
  ["from './query-pipeline.js'", "from '@kb/core/service/query-pipeline.js'"],
  ["from './serialize.js'", "from '@kb/core/service/serialize.js'"],
  ["from '../server/kb-service.js'", "from '@kb/core/service/kb-service.js'"],
  ["from '../server/kb-service'", "from '@kb/core/service/kb-service.js'"],
  ["from '../server/query-pipeline.js'", "from '@kb/core/service/query-pipeline.js'"],
  ["from '../server/serialize.js'", "from '@kb/core/service/serialize.js'"],
  // tests old paths
  ['../../src/cli/kb-config', '@kb/core/config/kb-config.js'],
  ['../../src/cli/base-selection', '@kb/core/storage/base-selection.js'],
  ['../../src/cli/base-meta', '@kb/core/storage/base-meta.js'],
  ['../../src/cli/init-cli', '@kb/core/ops/init-cli.js'],
  ['../../src/cli/scan-command', '@kb/core/ops/scan-command.js'],
  ['../../src/cli/auto-sync', '@kb/core/ops/auto-sync.js'],
  ['../../src/cli/intent-cli', '@kb/core/query/intent-cli.js'],
  ['../../src/cli/query-truth-retrieval', '@kb/core/query/query-truth-retrieval.js'],
  ['../../src/server/kb-service', '@kb/core/service/kb-service.js'],
  ['../../src/server/query-pipeline', '@kb/core/service/query-pipeline.js'],
  ['../../src/server/server-cli', '@kb/server/server-cli.js'],
  ['../../src/server/reindex-scheduler', '@kb/server/reindex-scheduler.js'],
  ['../../src/server/http-server', '@kb/server/http-server.js'],
  ['../../src/server/slack-handler', '@kb/server/slack-handler.js'],
]

function fixKbCoreInternal(content, filePath) {
  if (!filePath.includes('packages/kb-core/src')) return content
  let out = content
  // Fix relative imports within moved kb-core subdirs
  const relMap = [
    ['../cli/kb-config', '@kb/core/config/kb-config.js'],
    ['../cli/base-selection', '@kb/core/storage/base-selection.js'],
    ['../cli/base-meta', '@kb/core/storage/base-meta.js'],
    ['../cli/init-cli', '@kb/core/ops/init-cli.js'],
    ['../cli/scan-command', '@kb/core/ops/scan-command.js'],
    ['../cli/auto-sync', '@kb/core/ops/auto-sync.js'],
    ['../cli/intent-cli', '@kb/core/query/intent-cli.js'],
    ['../cli/query-truth-retrieval', '@kb/core/query/query-truth-retrieval.js'],
    ['../cli/init-source-files-manifest', '@kb/core/ops/init-source-files-manifest.js'],
    ['../cli/init-source-snapshots', '@kb/core/ops/init-source-snapshots.js'],
    ['../cli/init-topic-coverage', '@kb/core/ops/init-topic-coverage.js'],
    ['../cli/init-ast-files-manifest', '@kb/core/ops/init-ast-files-manifest.js'],
    ['../cli/retrieval-fallback', '@kb/core/query/retrieval-fallback.js'],
    ['../cli/git-sync', '@kb/core/ops/git-sync.js'],
    ['../cli/index.js', '@kb/client/cli/index.js'],
    ['../cli/index', '@kb/client/cli/index.js'],
    ['../server/session-store.js', '@kb/server/session-store.js'],
    ['../server/session-store', '@kb/server/session-store.js'],
    ['../server/chat-stream.js', '@kb/server/chat-stream.js'],
    ['../server/chat-stream', '@kb/server/chat-stream.js'],
  ]
  for (const [from, to] of relMap) {
    out = out.replaceAll(`from '${from}'`, `from '${to}'`)
    out = out.replaceAll(`from '${from}.js'`, `from '${to}'`)
    out = out.replaceAll(`from "${from}"`, `from "${to}"`)
    out = out.replaceAll(`from "${from}.js"`, `from "${to}"`)
  }
  return out
}

for (const rel of ['packages', 'tests']) {
  const abs = path.join(root, rel)
  if (!statSync(abs).isDirectory()) continue
  for (const file of walk(abs)) {
    const content = readFileSync(file, 'utf-8')
    let next = content
    for (const [from, to] of REPLACEMENTS) {
      next = next.replaceAll(from, to)
    }
    next = fixKbCoreInternal(next, file)
    if (next !== content) writeFileSync(file, next)
  }
}

console.log('Core relocation import fix complete')
