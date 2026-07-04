import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, acc)
    else if (name.endsWith('.test.ts')) acc.push(abs)
  }
  return acc
}

const REPLACEMENTS = [
  ['@kb/server/server/kb-service.js', '@kb/core/service/kb-service.js'],
  ['@kb/server/server/query-pipeline.js', '@kb/core/service/query-pipeline.js'],
  ['@kb/server/server/serialize.js', '@kb/core/service/serialize.js'],
  ['@kb/server/server/session-store.js', '@kb/core/service/session-store.js'],
  ['@kb/server/server/server-cli.js', '@kb/server/server-cli.js'],
  ['@kb/server/server/server-bootstrap.js', '@kb/server/server-bootstrap.js'],
  ['@kb/server/server/http-server.js', '@kb/server/http-server.js'],
  ['@kb/server/server/slack-handler.js', '@kb/server/slack-handler.js'],
  ['@kb/server/server/reindex-scheduler.js', '@kb/server/reindex-scheduler.js'],
  ['@kb/server/server/mcp-tools.js', '@kb/server/mcp-tools.js'],
  ['@kb/server/server/chat-stream.js', '@kb/server/chat-stream.js'],
  ["vi.mock('../../src/cli/git-sync'", "vi.mock('@kb/core/ops/git-sync.js'"],
  ["vi.mock('../../src/server/server-bootstrap'", "vi.mock('@kb/server/server-bootstrap.js'"],
  ["vi.mock('../../src/tools/graph-query-expansion'", "vi.mock('@kb/core/tools/graph-query-expansion.js'"],
  ["vi.mock('../../src/tools/kb-tools-registry'", "vi.mock('@kb/core/tools/kb-tools-registry.js'"],
  ["vi.mock('../../src/cli/index.js'", "vi.mock('@kb/client/cli/index.js'"],
]

for (const file of walk(path.join(root, 'tests'))) {
  const content = readFileSync(file, 'utf-8')
  let next = content
  for (const [from, to] of REPLACEMENTS) next = next.replaceAll(from, to)
  if (next !== content) writeFileSync(file, next)
}

console.log('Test import fixes applied')
