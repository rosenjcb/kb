#!/usr/bin/env node

/**
 * KB Agent Harness CLI
 */

import { createKBToolsRegistry } from '../tools/kb-tools-registry'
import {
  applyConfigToEnv,
  ensureDefaultConfig,
  createLLMProviderFromConfig,
  persistInferredLLMProvider,
  resolveConversationalChatEnabled,
  resolveGraphEnabled,
} from './kb-config'
import type { KbConfig } from './kb-config'
import { runIntentLoop } from '../core/intent-loop'
import { RunCollector, ReportWriter, defaultLogsDir, TokenCountingProvider, estimateCost } from '../core/telemetry'
import { invalidateFactTool } from '../tools/invalidate-fact-tool'
import {
  augmentIntentResultWithWorkspaceFallback,
  enrichReadDocumentsAnswerWithLLM,
  formatIntentResult,
  isIntentCommand,
  parseIntentCommand,
  printIntentHelp,
  rewriteIntentInputWithSessionContext,
} from './intent-cli'
import {
  ensureOperationalBaseDir,
  formatDefaultCommandHelp,
  formatUseCommandHelp,
  migrateLegacyKbSessionJson,
  readBaseConfig,
  resolveEffectiveBaseDir,
  writeDefaultBase,
  writeSessionBase,
} from './base-selection'
import {
  CLI_ERROR_NO_KB_BASE,
  CLI_ERROR_NO_LLM_PROVIDER,
  formatPrerequisiteError,
} from './cli-prerequisites'
import { runConfigCommand, printConfigHelp } from './config-cli'
import { parsePublishCommand, runPublishCommand } from './publish-cli'
import { parseInitCommand, runKbInit } from './init-cli'
import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from './cmd-ref'
import { DuckGraphWriter } from '../tools/duck-graph-writer'
import { extractGraph } from '../tools/graph-entity-extractor'
import { expandQueryWithGraph } from '../tools/graph-query-expansion'
import { GraphCommandError, parseGraphCommand, printGraphHelp, runGraphCommand } from './graph-cli'
import { printChatHelp, runChatSession } from './chat-cli'
import { printLogsHelp, runLogsCommand } from './logs-cli'
import {
  printListHelp,
  printViewHelp,
  runListCommand,
  runViewCommand,
  ViewCommandError,
} from './view-cli'

// ---------------------------------------------------------------------------
// Output abstraction — lets the TUI capture output without monkey-patching
// ---------------------------------------------------------------------------

export interface CliOutput {
  log(message: string): void
  error(message: string): void
  write(chunk: string): void
}

const defaultCliOutput: CliOutput = {
  log: msg => console.log(msg),
  error: msg => console.error(msg),
  write: chunk => process.stdout.write(chunk),
}

// ---------------------------------------------------------------------------
// Help printers
// ---------------------------------------------------------------------------

export function printCliHelp(mode: CmdMode = 'cli'): string {
  return [
    cmdIntro(mode),
    '',
    'Usage:',
    `  kb`,
    `  ${cmd('<command>', mode)} [options]`,
    `  ${cmd('<intent-command>', mode)} "<input>" [options]`,
    '',
    'Core commands:',
    '  docs        Browse KB documents',
    '  use         Switch the active base or save a default',
    '  config      Inspect or update persistent config',
    '  init        Build a KB from project docs',
    '  graph       Inspect the knowledge graph',
    '  logs        Browse and compare run reports',
    '  publish     Publish KB docs',
    '  chat        Start an interactive KB chat session',
    '  invalidate  Remove or replace stale KB facts',
    '',
    'Intent commands:',
    '  query       Search the knowledge base',
    '  submit      Store a fact or checkpoint',
    '  validate    Check whether a fact is supported',
    '  dispute     Record counter-evidence for a fact',
    '  explain     Explain a fact or change id',
    '',
    cmdHelpHint(mode),
    '',
    'Examples:',
    `  ${cmd('use dogfood', mode)}`,
    `  ${cmd('use --default dogfood', mode)}`,
    `  ${cmd('docs list --base dogfood --limit 20', mode)}`,
    `  ${cmd('docs view kb-base-selection-and-usage', mode)}`,
    `  ${cmd('submit "SQLite hybrid search is enabled in dogfood"', mode)}`,
  ].join('\n')
}

function printUseHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('use', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('use <base>', mode)}`,
    `  ${cmd('use --default <base>', mode)}`,
    `  ${cmd('use --show', mode)}`,
    '',
    'Examples:',
    `  ${cmd('use dogfood', mode)}`,
    `  ${cmd('use --default dogfood', mode)}`,
    `  ${cmd('use --show', mode)}`,
  ].join('\n')
}

function printDocsHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('docs list', mode)} [options]`,
    `  ${cmd('docs view <document-id>', mode)} [options]`,
    '',
    printListHelp(mode),
    '',
    printViewHelp(mode),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Main dispatch — accepts an output writer so the TUI can capture results
// ---------------------------------------------------------------------------

export async function runMainWithOutput(
  args: string[],
  out: CliOutput,
  config: KbConfig,
  mode: CmdMode = 'cli',
): Promise<void> {
  const firstArg = args[0]

  // kb invalidate
  if (firstArg === 'invalidate') {
    const oldFact = args[1]
    const replacementFact = args[2] && !args[2].startsWith('--') ? args[2] : undefined
    const preview = args.includes('--preview') || !args.includes('--apply')
    const dryRun = args.includes('--dry-run')
    const debug = args.includes('--debug')

    if (!oldFact) {
      out.error(`❌ Usage: ${cmd('invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run] [--debug]', mode)}`)
      return
    }

    const reporter = new ReportWriter(defaultLogsDir())
    const collector = new RunCollector('invalidate', { debug })
    const endInvalidate = collector.startStage('invalidate', 'none', 'none')
    try {
      const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir
      const result = await invalidateFactTool(
        { oldFact, replacementFact, preview, dryRun, includeSessionLogs: true },
        kbStorageDir,
      )
      endInvalidate({ inputTokens: 0, outputTokens: 0 })

      for (const change of result.changes) {
        out.log(`\nDocument: ${change.documentId} (${change.title})\nReplaced: ${change.replaced}\nDiff:\n${change.diff}`)
      }
      out.log(`\n${result.summary}`)
      if (result.error) {
        out.error(`❌ ${result.error}`)
      }

      if (!preview && !dryRun && result.changes.length > 0) {
        try {
          const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(kbStorageDir))
          await graphWriter.open()
          for (const change of result.changes) {
            await graphWriter.softDeleteByDocId(change.documentId)
          }
          graphWriter.close()
        } catch {
          // Graph soft-delete failure must not surface to the user
        }
      }
      await reporter.append(collector.finish('success'))
    } catch (error) {
      endInvalidate({ inputTokens: 0, outputTokens: 0 })
      const message = error instanceof Error ? error.message : String(error)
      await reporter.append(collector.finish('error', message))
      out.error(`❌ ${message}`)
    }
    return
  }

  if (args.length === 0 || firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    out.log(printCliHelp(mode))
    return
  }

  if (firstArg === 'use') {
    const show = args.includes('--show')
    const makeDefault = args.includes('--default')
    const help = args.includes('--help') || args.includes('-h') || args[1] === 'help'
    const base = args.find((token, index) => index > 0 && !token.startsWith('--'))

    if (help) {
      out.log(printUseHelp(mode))
      return
    }

    if (show || !base) {
      const configured = await readBaseConfig()
      let effective: Awaited<ReturnType<typeof resolveEffectiveBaseDir>> | null = null
      try {
        effective = await resolveEffectiveBaseDir()
      } catch {
        // No active base configured yet.
      }
      out.log('KB base configuration')
      if (effective) {
        out.log(`Source: ${effective.source}`)
        out.log(`Base: ${effective.baseName}`)
        out.log(`Resolved path: ${effective.baseDir}`)
      } else {
        out.log(CLI_ERROR_NO_KB_BASE)
      }
      if (configured.activeBase) {
        out.log(`Active base: ${configured.activeBase}`)
      }
      if (configured.selectedBase) {
        out.log(`Default base: ${configured.selectedBase}`)
      }
      return
    }

    if (makeDefault) {
      const saved = await writeDefaultBase(base)
      const resolved = await ensureOperationalBaseDir(saved.selectedBase ?? base)
      out.log(formatDefaultCommandHelp(saved.selectedBase ?? base, resolved, mode))
      return
    }

    await writeSessionBase(base)
    const resolved = await ensureOperationalBaseDir(base)
    out.log(formatUseCommandHelp(base, resolved, mode))
    return
  }

  if (firstArg === 'default') {
    const base = args[1]
    if (base === '--show' || !base) {
      const configured = await readBaseConfig()
      if (!configured.selectedBase) {
        out.log('No default base configured.')
        out.log(`  Set one with: ${cmd('use --default <base>', mode)}`)
        return
      }
      const resolved = await ensureOperationalBaseDir(configured.selectedBase)
      out.log(`Default base: ${configured.selectedBase}`)
      out.log(`Resolved path: ${resolved}`)
      if (configured.activeBase) {
        out.log(`Current active base: ${configured.activeBase}`)
      }
      out.log(`Use \`${cmd('use <base>', mode)}\` to switch the active base without changing the saved default.`)
      return
    }

    const saved = await writeDefaultBase(base)
    const resolved = await ensureOperationalBaseDir(saved.selectedBase ?? base)
    out.log(formatDefaultCommandHelp(saved.selectedBase ?? base, resolved, mode))
    return
  }

  if (firstArg === 'chat') {
    if (args.includes('--help') || args.includes('-h') || args[1] === 'help') {
      out.log(printChatHelp(mode))
      return
    }

    const chatBaseFlag = args[args.indexOf('--base') + 1] ?? undefined
    let kbStorageDir: string
    try {
      kbStorageDir = chatBaseFlag
        ? await ensureOperationalBaseDir(chatBaseFlag)
        : (await resolveEffectiveBaseDir()).baseDir
    } catch {
      out.error(formatPrerequisiteError(CLI_ERROR_NO_KB_BASE))
      return
    }
    const llmProvider = createLLMProviderFromConfig(config)

    if (!llmProvider) {
      out.error(formatPrerequisiteError(CLI_ERROR_NO_LLM_PROVIDER))
      return
    }

    const toolExecutor = createKBToolsRegistry(kbStorageDir, config)
    const chatGraphWriter = resolveGraphEnabled(config)
      ? new DuckGraphWriter(DuckGraphWriter.dbPathForBase(kbStorageDir))
      : undefined
    out.log(`🗂️ KB Storage: ${kbStorageDir}`)
    out.log('')
    await runChatSession({
      llmProvider,
      toolExecutor,
      graphWriter: chatGraphWriter,
      conversationalRetrieval: resolveConversationalChatEnabled(config),
    })
    return
  }

  if (firstArg === 'config') {
    try {
      const result = await runConfigCommand(args.slice(1), { isTTY: Boolean(process.stdout.isTTY), mode })
      out.log(result.output)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith(printConfigHelp(mode).split('\n')[0])) {
        out.log(message)
        return
      }
      out.error(`❌ ${message}`)
    }
    return
  }

  if (firstArg === 'publish') {
    try {
      const parsed = parsePublishCommand(args.slice(1))
      const result = await runPublishCommand({
        ...parsed,
        progressSink: line => out.log(line.trimEnd()),
      })
      out.log(JSON.stringify(result, null, 2))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      out.error(`❌ ${message}`)
    }
    return
  }

  if (firstArg === 'docs') {
    const docsAction = args[1]

    if (!docsAction || docsAction === '--help' || docsAction === '-h' || docsAction === 'help') {
      out.log(printDocsHelp(mode))
      return
    }

    if (docsAction === 'view') {
      try {
        const result = await runViewCommand(args.slice(2))
        out.write(result.output)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const exitCode = error instanceof ViewCommandError ? error.exitCode : 1
        if (exitCode === 0) {
          out.log(message)
          return
        }
        out.error(`❌ ${message}`)
      }
      return
    }

    if (docsAction === 'list') {
      try {
        const result = await runListCommand(args.slice(2))
        out.write(result.output)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const exitCode = error instanceof ViewCommandError ? error.exitCode : 1
        if (exitCode === 0) {
          out.log(message)
          return
        }
        out.error(`❌ ${message}`)
      }
      return
    }

    out.error(`❌ Unknown docs action: ${docsAction}`)
    out.error('')
    out.error(printDocsHelp(mode))
    return
  }

  if (firstArg === 'view') {
    out.error(`❌ \`${cmd('view', mode)}\` has moved to \`${cmd('docs view', mode)}\`.`)
    return
  }

  if (firstArg === 'list') {
    out.error(`❌ \`${cmd('list', mode)}\` has moved to \`${cmd('docs list', mode)}\`.`)
    return
  }

  if (firstArg === 'init') {
    const reporter = new ReportWriter(defaultLogsDir())
    const collector = new RunCollector('init')
    try {
      const parsed = parseInitCommand(args.slice(1))
      const initCollector = new RunCollector('init', { debug: parsed.debug })
      const result = await runKbInit({ ...parsed, collector: initCollector })
      out.log(JSON.stringify(result, null, 2))
      await reporter.append(initCollector.finish('success'))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await reporter.append(collector.finish('error', message))
      out.error(`❌ ${message}`)
    }
    return
  }

  if (firstArg === 'logs') {
    try {
      out.log(await runLogsCommand(args.slice(1)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('kb logs')) {
        out.log(message)
        return
      }
      out.error(`❌ ${message}`)
      out.error('')
      out.log(printLogsHelp(mode))
    }
    return
  }

  if (firstArg === 'graph') {
    try {
      const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir
      const opts = parseGraphCommand(args.slice(1), mode)
      await runGraphCommand(kbStorageDir, opts, out)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof GraphCommandError && error.exitCode === 0) {
        out.log(message)
        return
      }
      out.error(`❌ ${message}`)
      if (!(error instanceof GraphCommandError)) {
        out.error('')
        out.error(printGraphHelp(mode))
      }
    }
    return
  }

  if (isIntentCommand(firstArg)) {
    const reporter = new ReportWriter(defaultLogsDir())
    let collector = new RunCollector(firstArg)
    try {
      let parsed = parseIntentCommand(args)
      collector = new RunCollector(firstArg, { debug: parsed.debug })
      let intentBaseDir: string
      try {
        intentBaseDir = parsed.base
          ? await ensureOperationalBaseDir(parsed.base)
          : (await resolveEffectiveBaseDir()).baseDir
      } catch {
        out.error(formatPrerequisiteError(CLI_ERROR_NO_KB_BASE))
        out.error('')
        out.error(printIntentHelp(mode))
        await reporter.append(collector.finish('error', CLI_ERROR_NO_KB_BASE))
        return
      }
      const rawLlmProvider = createLLMProviderFromConfig(config)
      const llmCounter = rawLlmProvider ? new TokenCountingProvider(rawLlmProvider) : undefined
      const llmProvider = llmCounter ?? rawLlmProvider
      parsed = await rewriteIntentInputWithSessionContext(parsed, llmProvider ?? undefined, intentBaseDir)
      if (parsed.envelope.intent === 'query_truth' && resolveGraphEnabled(config)) {
        const payload = parsed.envelope.payload as { query?: string }
        const originalQuery = typeof payload.query === 'string' ? payload.query.trim() : ''
        if (originalQuery) {
          const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(intentBaseDir))
          try {
            payload.query = await expandQueryWithGraph(originalQuery, graphWriter)
          } finally {
            graphWriter.close()
          }
        }
      }
      const toolExecutor = createKBToolsRegistry(intentBaseDir, config)
      const { result } = await runIntentLoop(parsed.envelope, toolExecutor, {
        provider: llmProvider ?? undefined,
        collector: collector,
      })

      if (
        parsed.envelope.intent === 'submit_fact' &&
        result.status === 'accepted' &&
        llmProvider &&
        resolveGraphEnabled(config)
      ) {
        const fact = String(parsed.envelope.payload.fact ?? '').trim()
        const submittedDocId = (result.data as { submission?: { id?: string } } | undefined)?.submission?.id
        if (fact) {
          try {
            const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(intentBaseDir))
            const { entities, relationships } = await extractGraph(fact, llmProvider, submittedDocId)
            if (entities.length > 0 || relationships.length > 0) {
              await graphWriter.open()
              if (entities.length > 0) await graphWriter.upsertEntities(entities)
              if (relationships.length > 0) await graphWriter.upsertRelationships(relationships)
              graphWriter.close()
            }
          } catch {
            // Graph extraction failure must not surface to the user
          }
        }
      }

      // Flush any tokens accumulated during the intent loop (e.g. LLM validation reasoning)
      if (llmCounter) {
        const loopTokens = llmCounter.getAndReset()
        if (loopTokens.inputTokens > 0 || loopTokens.outputTokens > 0) {
          collector.addStage({
            stage: `${parsed.envelope.intent}:llm`,
            startedAt: new Date().toISOString(),
            durationMs: 0,
            inputTokens: loopTokens.inputTokens,
            outputTokens: loopTokens.outputTokens,
            estimatedCostUsd: llmProvider ? estimateCost(llmProvider.name, llmProvider.model, loopTokens.inputTokens, loopTokens.outputTokens) : 0,
            provider: llmProvider?.name ?? 'unknown',
            model: llmProvider?.model ?? 'unknown',
          })
        }
      }

      const aligned = await augmentIntentResultWithWorkspaceFallback(parsed, result, process.cwd())
      const enriched = await enrichReadDocumentsAnswerWithLLM(parsed, aligned, llmProvider ?? undefined, intentBaseDir)

      // Capture tokens from the answer-enrichment LLM call (query path)
      if (llmCounter) {
        const enrichTokens = llmCounter.getAndReset()
        if (enrichTokens.inputTokens > 0 || enrichTokens.outputTokens > 0) {
          collector.addStage({
            stage: `${parsed.envelope.intent}:answer-enrichment`,
            startedAt: new Date().toISOString(),
            durationMs: 0,
            inputTokens: enrichTokens.inputTokens,
            outputTokens: enrichTokens.outputTokens,
            estimatedCostUsd: llmProvider ? estimateCost(llmProvider.name, llmProvider.model, enrichTokens.inputTokens, enrichTokens.outputTokens) : 0,
            provider: llmProvider?.name ?? 'unknown',
            model: llmProvider?.model ?? 'unknown',
          })
        }
      }

      out.log(formatIntentResult(enriched, parsed.output))
      await reporter.append(collector.finish('success'))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await reporter.append(collector.finish('error', message))
      out.error(`❌ ${message}`)
      out.error('')
      out.error(printIntentHelp(mode))
    }
    return
  }

  out.error(`❌ Unrecognized command: ${firstArg}`)
  out.error('')
  out.log(printCliHelp(mode))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  await migrateLegacyKbSessionJson()
  let kbConfig = await ensureDefaultConfig()
  const inferred = await persistInferredLLMProvider({ config: kbConfig })
  kbConfig = inferred.config
  applyConfigToEnv(kbConfig)

  const args = process.argv.slice(2)
  const isTTY = Boolean(process.stdout.isTTY)

  // Launch TUI when invoked interactively with no arguments
  if (isTTY && args.length === 0) {
    const { launchTui } = await import('../tui/index.js')
    await launchTui(kbConfig, { startupNotices: inferred.notice ? [inferred.notice] : [] })
    return
  }

  // One-shot CLI path
  console.log('🤖 KB Agent Harness\n')
  if (inferred.notice) {
    console.log(inferred.notice)
    console.log('')
  }
  await runMainWithOutput(args, defaultCliOutput, kbConfig)
}

main().catch(console.error)
