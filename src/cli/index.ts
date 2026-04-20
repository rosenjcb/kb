#!/usr/bin/env node

/**
 * KB Agent Harness CLI
 */

import { runIntentLoop } from '../core/intent-loop'
import {
  ReportWriter,
  RunCollector,
  TokenCountingProvider,
  defaultLogsDir,
  estimateCost,
} from '../core/telemetry'
import { DuckGraphWriter } from '../tools/duck-graph-writer'
import { extractGraph } from '../tools/graph-entity-extractor'
import { expandQueryWithGraph } from '../tools/graph-query-expansion'
import { invalidateFactTool } from '../tools/invalidate-fact-tool'
import { createKBToolsRegistry } from '../tools/kb-tools-registry'
import {
  deleteBase,
  ensureOperationalBaseDir,
  formatDefaultCommandHelp,
  formatDeleteBaseResult,
  formatUseCommandHelp,
  migrateLegacyKbSessionJson,
  printBaseDeleteHelp,
  readBaseConfig,
  resolveEffectiveBaseDir,
  writeDefaultBase,
  writeSessionBase,
} from './base-selection'
import { printChatHelp, runChatSession } from './chat-cli'
import {
  CLI_ERROR_NO_KB_BASE,
  CLI_ERROR_NO_LLM_PROVIDER,
  formatPrerequisiteError,
} from './cli-prerequisites'
import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from './cmd-ref'
import { printConfigHelp, runConfigCommand } from './config-cli'
import { GraphCommandError, parseGraphCommand, printGraphHelp, runGraphCommand } from './graph-cli'
import { parseInitCommand, runKbInit } from './init-cli'
import {
  augmentIntentResultWithWorkspaceFallback,
  enrichReadDocumentsAnswerWithLLM,
  isIntentCommand,
  parseIntentCommand,
  printIntentResult,
  printIntentHelp,
  rewriteIntentInputWithSessionContext,
} from './intent-cli'
import { createPrinter } from '../ui/printer'
import {
  applyConfigToEnv,
  createLLMProviderFromConfig,
  ensureDefaultConfig,
  persistInferredLLMProvider,
  resolveConversationalChatEnabled,
  resolveGraphEnabled,
} from './kb-config'
import type { KbConfig } from './kb-config'
import { printLogsHelp, runLogsCommand } from './logs-cli'
import { parsePublishCommand, runPublishCommand } from './publish-cli'
import { parseJekyllPublishOptions, runJekyllPublish } from './publish-jekyll'
import {
  formatSkillInstallReport,
  installSkillIntoProject,
  installSkillsGlobally,
} from './skill-installer'
import {
  ViewCommandError,
  printListHelp,
  printViewHelp,
  runListCommand,
  runViewCommand,
} from './view-cli'
import {
  DocsMergeError,
  parseDocsMergeCommand,
  printDocsMergeHelp,
  runDocsMerge,
} from './docs-merge-cli'
import {
  DocsRenameError,
  parseDocsRenameCommand,
  printDocsRenameHelp,
  runDocsRename,
} from './docs-rename-cli'
import {
  DocsDeleteError,
  parseDocsDeleteCommand,
  printDocsDeleteHelp,
  runDocsDelete,
} from './docs-delete-cli'

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
    '  kb',
    `  ${cmd('<command>', mode)} [options]`,
    `  ${cmd('<intent-command>', mode)} "<input>" [options]`,
    '',
    'Core commands:',
    '  base        Manage KB bases (use, delete)',
    '  config      Inspect or update persistent config',
    '  init        Build a KB from project docs',
    '  graph       Inspect the knowledge graph',
    '  docs        Browse KB documents',
    '  chat        Start an interactive KB chat session',
    '  publish     Publish KB docs',
    '  logs        Browse and compare run reports',
    '  skill       Manage agent skills',
    '',
    'Intent commands:',
    '  query       Search the knowledge base',
    '  submit      Store a fact or checkpoint',
    '  validate    Check whether a fact is supported',
    '  explain     Explain a fact or change id',
    '  invalidate  Remove or replace stale KB facts',
    '',
    cmdHelpHint(mode),
    '',
    'Examples:',
    `  ${cmd('base use dogfood', mode)}`,
    `  ${cmd('base use --default dogfood', mode)}`,
    `  ${cmd('base delete ci-test --force', mode)}`,
    `  ${cmd('docs list --base dogfood --limit 20', mode)}`,
    `  ${cmd('docs view kb-base-selection-and-usage', mode)}`,
    `  ${cmd('submit "SQLite hybrid search is enabled in dogfood"', mode)}`,
  ].join('\n')
}

function printBaseHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('base', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('base use <base>', mode)}`,
    `  ${cmd('base use --default <base>', mode)}`,
    `  ${cmd('base use --show', mode)}`,
    `  ${cmd('base delete <base> [--force]', mode)}`,
    '',
    'Examples:',
    `  ${cmd('base use dogfood', mode)}`,
    `  ${cmd('base use --default dogfood', mode)}`,
    `  ${cmd('base use --show', mode)}`,
    `  ${cmd('base delete ci-test --force', mode)}`,
  ].join('\n')
}

function printDocsHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('docs list', mode)} [options]`,
    `  ${cmd('docs view <document-id>', mode)} [options]`,
    `  ${cmd('docs merge <targetDocId> <sourceDocId> [...]', mode)} [options]`,
    `  ${cmd('docs rename <documentId> "<new title>"', mode)} [options]`,
    `  ${cmd('docs delete <documentId>', mode)} [options]`,
    '',
    printListHelp(mode),
    '',
    printViewHelp(mode),
    '',
    printDocsMergeHelp(mode),
    '',
    printDocsRenameHelp(mode),
    '',
    printDocsDeleteHelp(mode),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Main dispatch — accepts an output writer so the TUI can capture results
// ---------------------------------------------------------------------------

export async function runMainWithOutput(
  args: string[],
  out: CliOutput,
  config: KbConfig,
  mode: CmdMode = 'cli'
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
      out.error(
        `❌ Usage: ${cmd('invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run] [--debug]', mode)}`
      )
      return
    }

    const reporter = new ReportWriter(defaultLogsDir())
    const collector = new RunCollector('invalidate', { debug })
    const endInvalidate = collector.startStage('invalidate', 'none', 'none')
    try {
      const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir
      const result = await invalidateFactTool(
        { oldFact, replacementFact, preview, dryRun, includeSessionLogs: true },
        kbStorageDir
      )
      endInvalidate({ inputTokens: 0, outputTokens: 0 })

      for (const change of result.changes) {
        out.log(
          `\nDocument: ${change.documentId} (${change.title})\nReplaced: ${change.replaced}\nDiff:\n${change.diff}`
        )
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
          await graphWriter.close()
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

  if (firstArg === 'base' || firstArg === 'use') {
    // `kb use ...` is a deprecated alias for `kb base use ...`
    // Normalize: if the user typed `kb use <args>`, treat it as `kb base use <args>`
    const subArgs = firstArg === 'use' ? ['use', ...args.slice(1)] : args.slice(1)
    const subCmd = subArgs[0]

    if (!subCmd || subCmd === '--help' || subCmd === '-h' || subCmd === 'help') {
      out.log(printBaseHelp(mode))
      return
    }

    if (subCmd === 'use') {
      const useArgs = subArgs.slice(1)
      const show = useArgs.includes('--show')
      const makeDefault = useArgs.includes('--default')
      const help = useArgs.includes('--help') || useArgs.includes('-h') || useArgs[0] === 'help'
      const base = useArgs.find((token, index) => index >= 0 && !token.startsWith('--'))

      if (help) {
        out.log(printBaseHelp(mode))
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

    if (subCmd === 'delete') {
      const deleteArgs = subArgs.slice(1)
      const help = deleteArgs.includes('--help') || deleteArgs.includes('-h') || deleteArgs[0] === 'help'
      if (help) {
        out.log(printBaseDeleteHelp(mode))
        return
      }

      const base = deleteArgs.find(token => !token.startsWith('--'))
      if (!base) {
        out.error(printBaseDeleteHelp(mode))
        return
      }

      const force = deleteArgs.includes('--force') || deleteArgs.includes('-f')
      if (!force) {
        const confirmed = await promptBaseDeleteConfirm(base)
        if (!confirmed) {
          out.log('Aborted.')
          return
        }
      }

      const result = await deleteBase(base)
      out.log(formatDeleteBaseResult(base, result, mode))
      return
    }

    out.error(`Unknown base subcommand: ${subCmd}\n\n${printBaseHelp(mode)}`)
    return
  }

  if (firstArg === 'default') {
    const base = args[1]
    if (base === '--show' || !base) {
      const configured = await readBaseConfig()
      if (!configured.selectedBase) {
        out.log('No default base configured.')
        out.log(`  Set one with: ${cmd('base use --default <base>', mode)}`)
        return
      }
      const resolved = await ensureOperationalBaseDir(configured.selectedBase)
      out.log(`Default base: ${configured.selectedBase}`)
      out.log(`Resolved path: ${resolved}`)
      if (configured.activeBase) {
        out.log(`Current active base: ${configured.activeBase}`)
      }
      out.log(
        `Use \`${cmd('base use <base>', mode)}\` to switch the active base without changing the saved default.`
      )
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

    const toolExecutor = createKBToolsRegistry(kbStorageDir, config, { taskProvider: llmProvider })
    const chatGraphWriter = resolveGraphEnabled(config)
      ? new DuckGraphWriter(DuckGraphWriter.dbPathForBase(kbStorageDir))
      : undefined
    out.log(`🗂️ KB Storage: ${kbStorageDir}`)
    out.log('')
    await runChatSession({
      llmProvider,
      toolExecutor,
      mode,
      graphWriter: chatGraphWriter,
      conversationalRetrieval: resolveConversationalChatEnabled(config),
    })
    return
  }

  if (firstArg === 'config') {
    try {
      const result = await runConfigCommand(args.slice(1), {
        isTTY: Boolean(process.stdout.isTTY),
        mode,
      })
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
    const provider = args[1]
    if (!provider || provider.startsWith('--')) {
      out.error('Usage: kb publish <notion|jekyll> [options]')
      return
    }
    try {
      if (provider === 'notion') {
        const parsed = parsePublishCommand(args.slice(2))
        const result = await runPublishCommand({
          ...parsed,
          progressSink: line => out.log(line.trimEnd()),
        })
        out.log(JSON.stringify(result, null, 2))
      } else if (provider === 'jekyll') {
        const parsed = parseJekyllPublishOptions(args.slice(2), process.cwd())
        const result = await runJekyllPublish(parsed, process.cwd())
        out.log(JSON.stringify(result, null, 2))
      } else {
        out.error(`Unknown provider "${provider}". Usage: kb publish <notion|jekyll> [options]`)
      }
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

    if (docsAction === 'merge') {
      try {
        const parsed = parseDocsMergeCommand(args.slice(2))
        const mergeBaseDir = parsed.base
          ? await ensureOperationalBaseDir(parsed.base)
          : (await resolveEffectiveBaseDir()).baseDir
        const mergeLlmProvider = createLLMProviderFromConfig(config)
        if (!mergeLlmProvider) {
          out.error(formatPrerequisiteError(CLI_ERROR_NO_LLM_PROVIDER))
          return
        }
        await runDocsMerge(parsed, mergeBaseDir, mergeLlmProvider, out)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const exitCode = error instanceof DocsMergeError ? error.exitCode : 1
        if (exitCode === 0) {
          out.log(message)
          return
        }
        out.error(`❌ ${message}`)
      }
      return
    }

    if (docsAction === 'delete') {
      try {
        const parsed = parseDocsDeleteCommand(args.slice(2))
        const deleteBaseDir = parsed.base
          ? await ensureOperationalBaseDir(parsed.base)
          : (await resolveEffectiveBaseDir()).baseDir
        await runDocsDelete(parsed, deleteBaseDir, out)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const exitCode = error instanceof DocsDeleteError ? error.exitCode : 1
        if (exitCode === 0) {
          out.log(message)
          return
        }
        out.error(`❌ ${message}`)
      }
      return
    }

    if (docsAction === 'rename') {
      try {
        const parsed = parseDocsRenameCommand(args.slice(2))
        const renameBaseDir = parsed.base
          ? await ensureOperationalBaseDir(parsed.base)
          : (await resolveEffectiveBaseDir()).baseDir
        await runDocsRename(parsed, renameBaseDir, out)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const exitCode = error instanceof DocsRenameError ? error.exitCode : 1
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
    const treatAsLogsList = args.slice(1).some(arg =>
      ['--since', '--command', '--limit'].includes(arg)
    )
    if (treatAsLogsList) {
      try {
        out.log(await runLogsCommand(['list', ...args.slice(1)]))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
        out.error('')
        out.log(printLogsHelp(mode))
      }
      return
    }
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

  if (firstArg === 'skill') {
    const subcommand = args[1]
    if (subcommand === 'install') {
      try {
        const results = await installSkillIntoProject(process.cwd())
        const report = formatSkillInstallReport(results)
        if (report) out.log(report)
        else out.log('No changes made.')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
      }
    } else {
      out.log(
        [
          'Usage: kb skill <subcommand>',
          '',
          'Subcommands:',
          '  install   Inject a KB skill reference into CLAUDE.md or AGENTS.md in the current directory',
        ].join('\n')
      )
    }
    return
  }

  if (isIntentCommand(firstArg)) {
    const reporter = new ReportWriter(defaultLogsDir())
    let collector = new RunCollector(firstArg)
    const printer = createPrinter(out, mode)
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
      printer.startSpinner('running intent rewrite...')
      try {
        parsed = await rewriteIntentInputWithSessionContext(
          parsed,
          llmProvider ?? undefined,
          intentBaseDir
        )
      } finally {
        printer.stopSpinner()
      }
      if (parsed.envelope.intent === 'query_truth' && resolveGraphEnabled(config)) {
        const payload = parsed.envelope.payload as { query?: string }
        const originalQuery = typeof payload.query === 'string' ? payload.query.trim() : ''
        if (originalQuery) {
          const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(intentBaseDir))
          try {
            payload.query = await expandQueryWithGraph(originalQuery, graphWriter)
          } finally {
            await graphWriter.close()
          }
        }
      }
      const toolExecutor = createKBToolsRegistry(intentBaseDir, config, {
        taskProvider: llmProvider ?? undefined,
      })
      printer.startSpinner('running intent loop...')
      const { result } = await runIntentLoop(parsed.envelope, toolExecutor, {
        provider: llmProvider ?? undefined,
        collector: collector,
      }).finally(() => {
        printer.stopSpinner()
      })

      if (
        parsed.envelope.intent === 'submit_fact' &&
        result.status === 'accepted' &&
        llmProvider &&
        resolveGraphEnabled(config)
      ) {
        const fact = String(parsed.envelope.payload.fact ?? '').trim()
        const submittedDocId = (result.data as { submission?: { id?: string } } | undefined)
          ?.submission?.id
        if (fact) {
          try {
            const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(intentBaseDir))
            const { entities, relationships } = await extractGraph(
              fact,
              llmProvider,
              submittedDocId
            )
            if (entities.length > 0 || relationships.length > 0) {
              await graphWriter.open()
              if (entities.length > 0) await graphWriter.upsertEntities(entities)
              if (relationships.length > 0) await graphWriter.upsertRelationships(relationships)
              await graphWriter.close()
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
            estimatedCostUsd: llmProvider
              ? estimateCost(
                  llmProvider.name,
                  llmProvider.model,
                  loopTokens.inputTokens,
                  loopTokens.outputTokens
                )
              : 0,
            provider: llmProvider?.name ?? 'unknown',
            model: llmProvider?.model ?? 'unknown',
          })
        }
      }

      const aligned = await augmentIntentResultWithWorkspaceFallback(parsed, result, process.cwd())
      printer.startSpinner('drafting final answer...')
      const enriched = await enrichReadDocumentsAnswerWithLLM(
        parsed,
        aligned,
        llmProvider ?? undefined,
        intentBaseDir
      ).finally(() => {
        printer.stopSpinner()
      })

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
            estimatedCostUsd: llmProvider
              ? estimateCost(
                  llmProvider.name,
                  llmProvider.model,
                  enrichTokens.inputTokens,
                  enrichTokens.outputTokens
                )
              : 0,
            provider: llmProvider?.name ?? 'unknown',
            model: llmProvider?.model ?? 'unknown',
          })
        }
      }

      printIntentResult(enriched, parsed.output, printer)
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

async function promptBaseDeleteConfirm(base: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(
      `Delete base "${base}" and all its data? This cannot be undone. [y/N]: `,
      answer => {
        rl.close()
        resolve(answer.trim().toLowerCase() === 'y')
      }
    )
  })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  await migrateLegacyKbSessionJson()
  installSkillsGlobally().catch(() => {}) // fire and forget — never block startup
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
