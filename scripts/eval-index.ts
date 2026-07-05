#!/usr/bin/env tsx
/**
 * Eval harness indexing — calls @kb/core directly (kb init/scan removed from client CLI).
 *
 * Usage:
 *   npx tsx scripts/eval-index.ts init --base <name> --git <path> [--non-interactive] [--debug]
 *   npx tsx scripts/eval-index.ts scan --base <name> [--debug]
 */

import { parseInitCommand, runKbInit } from '@kb/core/ops/init-cli.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'

async function main(): Promise<void> {
  const mode = process.argv[2]
  const rest = process.argv.slice(3)

  if (mode === 'init') {
    const parsed = parseInitCommand(rest)
    const result = await runKbInit({
      ...parsed,
      nonInteractive: true,
      progressSink: line => process.stderr.write(`${line}\n`),
    })
    process.stdout.write(
      `${JSON.stringify({
        status: 'accepted',
        base: result.base,
        writtenDocIds: result.writtenDocIds ?? [],
        completedCycles: result.completedCycles ?? [],
      })}\n`
    )
    return
  }

  if (mode === 'scan') {
    const summary = await runScanCommand(rest, line => process.stderr.write(`${line}\n`))
    process.stdout.write(`${summary}\n`)
    return
  }

  console.error('Usage: eval-index.ts init|scan [args…]')
  process.exit(1)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
