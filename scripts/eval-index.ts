#!/usr/bin/env tsx
/**
 * Eval harness indexing — calls @kb/core directly (kb init/scan removed from client CLI).
 *
 * Usage (from kb repo root, after pnpm install):
 *   pnpm exec tsx scripts/eval-index.ts init --base <name> --git <path> [--non-interactive] [--debug] [--skip-embed]
 *   pnpm exec tsx scripts/eval-index.ts scan --base <name> [--debug] [--skip-embed]
 *
 * `--skip-embed` skips the create-embeddings cycle (init) / embed pass (scan) entirely — no
 * vectors are written. For a fast reindex where only lexical/AST retrieval is under test.
 */

import { ReportWriter, RunCollector, defaultLogsDir } from '@kb/core/core/telemetry.js'
import { parseInitCommand, runKbInit } from '@kb/core/ops/init-cli.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'

async function main(): Promise<void> {
  const mode = process.argv[2]
  const rest = process.argv.slice(3)
  const reporter = new ReportWriter(defaultLogsDir())

  if (mode === 'init') {
    const parsed = parseInitCommand(rest)
    const collector = new RunCollector('init')
    try {
      const result = await runKbInit({
        ...parsed,
        nonInteractive: true,
        // Eval indexes are only useful with embeddings — a rate-limited/offline embedder must
        // fail the reindex loudly rather than publish a lexical-only base that scores nothing.
        requireEmbeddings: true,
        progressSink: line => process.stderr.write(`${line}\n`),
        collector,
      })
      await reporter.append(collector.finish('success', undefined, result.base))
      process.stdout.write(
        `${JSON.stringify({
          status: 'accepted',
          base: result.base,
          writtenDocIds: result.writtenDocIds ?? [],
          completedCycles: result.completedCycles ?? [],
        })}\n`
      )
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await reporter.append(collector.finish('error', message))
      throw error
    }
  }

  if (mode === 'scan') {
    const collector = new RunCollector('scan')
    try {
      const summary = await runScanCommand(
        rest,
        line => process.stderr.write(`${line}\n`),
        collector
      )
      await reporter.append(collector.finish('success', undefined))
      process.stdout.write(`${summary}\n`)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await reporter.append(collector.finish('error', message))
      throw error
    }
  }

  console.error('Usage: eval-index.ts init|scan [args…]')
  process.exit(1)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
