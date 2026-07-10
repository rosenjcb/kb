#!/usr/bin/env node

/**
 * KB Agent Harness CLI
 */


import chalk from 'chalk'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  ReportWriter,
  RunCollector,
  TokenCountingProvider,
  defaultLogsDir,
  estimateCost,
  summarizeQueryRetrievalTrace,
} from '@kb/core/core/telemetry.js'
import { DatabaseSync } from 'node:sqlite'
import { expandQueryWithGraph, kbIndexDbPath } from '@kb/core/tools/graph-query-expansion.js'
import { formatGraphRelationBlockFromQuestion } from '@kb/core/tools/graph-relation-context.js'
import { createKBToolsRegistry } from '@kb/core/tools/kb-tools-registry.js'
import { KB_VERSION } from '@kb/core/version.js'
import { isEnvTrue } from '@kb/core/config/env-boolean.js'
import { createPrinter, createReasoningProgressSink } from '../ui/printer'
import {
  deleteBase,
  ensureOperationalBaseDir,
  findKbFile,
  formatDefaultCommandHelp,
  formatDeleteBaseResult,
  formatUseCommandHelp,
  listAllBases,
  migrateLegacyKbSessionJson,
  printBaseDeleteHelp,
  readBaseConfig,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  resolveKbStorageDirFromArgs,
  stripCliFlagWithValue,
  writeDefaultBase,
  writeSessionBase,
} from '@kb/core/storage/base-selection.js'
import {
  CLI_ERROR_NO_KB_BASE,
  formatPrerequisiteError,
  uninitializedBaseNotice,
} from '@kb/core/config/cli-prerequisites.js'
import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from '@kb/core/config/cmd-ref.js'
import {
  DocsDeleteError,
  parseDocsDeleteCommand,
  printDocsDeleteHelp,
  runDocsDelete,
} from '@kb/core/cli/docs-delete-cli.js'
import {
  DocsGenerateError,
  formatDocsGenerateHumanOutput,
  isDocsGenerateJsonOutputArgs,
  parseDocsGenerateCommand,
  printDocsGenerateHelp,
  runDocsGenerate,
} from '@kb/core/cli/docs-generate-cli.js'
import {
  DocsRenameError,
  parseDocsRenameCommand,
  printDocsRenameHelp,
  runDocsRename,
} from '@kb/core/cli/docs-rename-cli.js'
import { FactsCommandError, runFactsCommand } from '@kb/core/cli/facts-cli.js'
import {
  GraphCommandError,
  parseGraphCommand,
  printGraphHelp,
  runGraphCommand,
} from '@kb/core/cli/graph-cli.js'
import {
  isIntentCommand,
  isReadFactsResult,
  parseIntentCommand,
  printIntentHelp,
  printIntentResult,
  enrichReadDocumentsAnswerWithLLM,
  getIntentQuestion,
  rewriteIntentInputWithSessionContext,
  type ReadDocumentsResultData,
} from '@kb/core/query/intent-cli.js'
import {
  llmExtractQueryEntities,
  rerankByGraphConnectivity,
} from '@kb/core/tools/graph-rag-reranker.js'
import {
  applyConfigToEnv,
  createLLMProviderFromConfig,
  ensureDefaultConfig,
  isFreshClientInstall,
  markClientInitialized,
  persistInferredLLMProvider,
  resolveFactRetrievalMethod,
} from '@kb/core/config/kb-config.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { printLogsHelp, runLogsCommand } from '@kb/core/cli/logs-cli.js'
import { parsePublishCommand, runPublishCommand } from '@kb/core/cli/publish-cli.js'
import { runQueryTruthRetrieval } from '@kb/core/query/query-truth-retrieval.js'
import {
  formatSkillInstallReport,
  formatSkillUninstallReport,
  installHooks,
  installMcpConfigs,
  installSkillIntoProject,
  installSkillsGlobally,
  uninstallHooks,
  uninstallMcpConfigs,
  uninstallSkills,
} from './skill-installer'
import { printSyncHelp, runSyncCommand } from './sync-cli'
import {
  isClientLocalCommand,
  runRemoteCliCommand,
  shouldUseRemoteServer,
} from './remote-commands.js'
import { resolveReportHost, resolveServerConnection, formatServerAddress, formatConnectionContext } from '../api/server-connection.js'
import { applyHostCliOverride, parseGlobalCliFlags } from '../api/cli-global-flags.js'
import { syncKbMcpConfigs } from '../api/mcp-config-sync.js'
import { runUninstallCommand } from './uninstall-cli'
import {
  ViewCommandError,
  printListHelp,
  printViewHelp,
  runListCommand,
  runViewCommand,
} from '@kb/core/cli/view-cli.js'

// ---------------------------------------------------------------------------
// Output abstraction — lets the TUI capture output without monkey-patching
// ---------------------------------------------------------------------------

import type { CliOutput } from '@kb/core/ui/cli-output.js'
export type { CliOutput } from '@kb/core/ui/cli-output.js'

const defaultCliOutput: CliOutput = {
  log: msg => console.log(msg),
  error: msg => console.error(msg),
  write: chunk => process.stdout.write(chunk),
}

// ---------------------------------------------------------------------------
// Startup notices
// ---------------------------------------------------------------------------

export const FIRST_RUN_WELCOME_NOTICE = [
  '👋 Welcome to KB!',
  '',
  'KB connects to a kb-server that indexes your git repos. You ask questions;',
  'the server returns grounded answers with sources.',
  '',
  'Quick start:',
  '  kb query       ask a question about your codebase',
  '  kb graph       explore how modules connect',
  '  kb docs        browse or generate documentation',
  '',
  'Type a question below or press ? for help.',
].join('\n')

// ---------------------------------------------------------------------------
// Help printers
// ---------------------------------------------------------------------------

export function printCliHelp(mode: CmdMode = 'cli'): string {
  return [
    cmdIntro(mode),
    '',
    'Usage:',
    '  kb [--host <host[:port]|url>]',
    `  kb [--host <host[:port]|url>] ${cmd('<command>', mode)} [options]`,
    `  kb [--host <host[:port]|url>] ${cmd('<intent-command>', mode)} "<input>" [options]`,
    '',
    'Global flags:',
    '  --host <host[:port]|url>   kb-server to use (else KB_HOST / KB_SERVER_URL env)',
    '',
    'Core commands:',
    '  base        Manage KB bases (use, delete)',
    '  graph       Inspect or edit the knowledge graph',
    '  docs        Browse KB documents',
    '  facts       List, search, or show KB facts',
    '  publish     Publish KB docs',
    '  sync        Install the latest published KB release',
    '  logs        Browse and compare run reports',
    '  skills      Manage agent skills',
    '  uninstall   Remove the kb client binary (server/data untouched; see kb-server uninstall)',
    '',
    'Intent commands:',
    '  query       Search the knowledge base',
    '',
    cmdHelpHint(mode),
    '',
    'Examples:',
    `  kb --host localhost:38117 ${cmd('query "how does auth work?"', mode)}`,
    `  ${cmd('base use dogfood', mode)}`,
    `  ${cmd('sync', mode)}`,
    `  ${cmd('docs list --base dogfood', mode)}`,
  ].join('\n')
}

function printBaseHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('base', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('base', mode)}                          Show status and list all bases`,
    `  ${cmd('base list', mode)}                     List all initialized bases`,
    `  ${cmd('base use <base>', mode)}               Switch the active base`,
    `  ${cmd('base use --default <base>', mode)}     Set the persistent default base`,
    `  ${cmd('base use --show', mode)}               Show current base configuration`,
    `  ${cmd('base delete <base> [--force]', mode)}  Delete a base`,
    '',
    'The repos a base indexes and the paths it skips are declared on the server via',
    'KB_SERVER_BASE_GIT_REPOS and KB_SERVER_IGNORE — see packages/kb-server/README.md.',
    '',
    'Examples:',
    `  ${cmd('base', mode)}`,
    `  ${cmd('base use dogfood', mode)}`,
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
    `  ${cmd('docs generate "<prompt>"', mode)} [options]  (see ${cmd('docs generate --help', mode)})`,
    `  ${cmd('docs rename <documentId> "<new title>"', mode)} [options]`,
    `  ${cmd('docs delete <documentId>', mode)} [options]`,
    '',
    printListHelp(mode),
    '',
    printViewHelp(mode),
    '',
    printDocsGenerateHelp(mode),
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
  mode: CmdMode = 'cli',
  sessionId?: string
): Promise<void> {
  const firstArg = args[0]

  // Help and no-arg invocations are always answered locally
  if (
    shouldUseRemoteServer() &&
    !isClientLocalCommand(args) &&
    args.length > 0 &&
    !isHelpOnlyInvocation(args)
  ) {
    const code = await runRemoteCliCommand(args, out, config, mode)
    if (code && mode === 'cli') process.exitCode = code
    return
  }

  if (args.length === 0 || firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    out.log(printCliHelp(mode))
    return
  }

  if (firstArg === 'base') {
    const subArgs = args.slice(1)
    const subCmd = subArgs[0]

    if (subCmd === '--help' || subCmd === '-h' || subCmd === 'help') {
      out.log(printBaseHelp(mode))
      return
    }

    if (!subCmd || subCmd === 'list') {
      const configured = await readBaseConfig()
      const kbFileBase = await findKbFile(process.cwd())
      let effective: Awaited<ReturnType<typeof resolveEffectiveBaseDir>> | null = null
      try {
        effective = await resolveEffectiveBaseDir()
      } catch {
        // No base configured yet.
      }

      const lines: string[] = ['KB base status']
      if (effective) {
        lines.push(`  Active: ${effective.baseName}  (source: ${effective.source})`)
      } else {
        lines.push('  Active: none')
      }
      if (configured.defaultBase) {
        lines.push(`  Default: ${configured.defaultBase}`)
      }
      if (kbFileBase) {
        lines.push(`  .kb file: ${kbFileBase}  (found in current or ancestor directory)`)
      }

      const bases = await listAllBases()
      lines.push('')
      if (bases.length === 0) {
        lines.push('No bases found on this server.')
        lines.push('  Configure KB_GIT_REPOS on kb-server, or run kb base use <base>.')
      } else {
        lines.push('Bases:')
        for (const b of bases) {
          const tags: string[] = []
          if (b.isActive) tags.push('active')
          if (b.isDefault) tags.push('default')
          const tagStr = tags.length ? `  [${tags.join(', ')}]` : ''
          lines.push(`  ${b.name}${tagStr}`)
          lines.push(`    ${b.path}`)
        }
      }
      out.log(lines.join('\n'))
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
        const kbFileBase = await findKbFile(process.cwd())
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
        if (configured.defaultBase) {
          out.log(`Default base: ${configured.defaultBase}`)
        }
        if (kbFileBase) {
          out.log(`.kb file: ${kbFileBase}  (found in current or ancestor directory)`)
        }
        return
      }

      const baseDir = resolveBaseToDir(base)
      const sqlitePath = path.join(baseDir, '.kb-index.sqlite')
      try {
        await stat(sqlitePath)
      } catch {
        out.error(uninitializedBaseNotice(base))
        return
      }

      await writeSessionBase(base)
      const resolved = await ensureOperationalBaseDir(base)
      const kbFileBase = await findKbFile(process.cwd())
      if (makeDefault) {
        await writeDefaultBase(base)
        out.log(formatDefaultCommandHelp(base, resolved, mode, kbFileBase ?? undefined))
        return
      }
      out.log(formatUseCommandHelp(base, resolved, mode, kbFileBase ?? undefined))
      return
    }

    if (subCmd === 'delete') {
      const deleteArgs = subArgs.slice(1)
      const help =
        deleteArgs.includes('--help') || deleteArgs.includes('-h') || deleteArgs[0] === 'help'
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
        if (mode === 'tui') {
          out.log(`Pass --force to confirm deletion in the TUI: /base delete ${base} --force`)
          return
        }
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

  if (firstArg === 'publish') {
    const provider = args[1]
    if (!provider || provider.startsWith('--')) {
      out.error('Usage: kb publish <notion> [options]')
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
      } else {
        out.error(`Unknown provider "${provider}". Usage: kb publish <notion> [options]`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      out.error(`❌ ${message}`)
    }
    return
  }

  if (firstArg === 'facts') {
    try {
      const text = await runFactsCommand(args.slice(1), { cwd: process.cwd() })
      out.log(text)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const exitCode = error instanceof FactsCommandError ? error.exitCode : 1
      if (exitCode === 0) {
        out.log(message)
        return
      }
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

    if (docsAction === 'generate') {
      const jsonOut = isDocsGenerateJsonOutputArgs(args)
      try {
        const parsed = parseDocsGenerateCommand(args.slice(2))
        const generated = await runDocsGenerate(parsed, process.cwd(), config)
        const payload = { status: 'accepted' as const, generated }
        if (parsed.outputFormat === 'json') {
          out.log(JSON.stringify(payload))
        } else {
          out.log(formatDocsGenerateHumanOutput(generated))
        }
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const exitCode = error instanceof DocsGenerateError ? error.exitCode : 1
        if (exitCode === 0) {
          out.log(message)
          return
        }
        if (jsonOut) {
          out.log(JSON.stringify({ status: 'error', message }))
        } else {
          out.error(`❌ ${message}`)
        }
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

  if (firstArg === 'sync') {
    try {
      out.log(await runSyncCommand(args.slice(1), { mode, onProgress: line => out.log(line) }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith(`${cmd('sync', mode)} command`)) {
        out.log(message)
        return
      }
      out.error(`❌ ${message}`)
      out.error('')
      out.log(printSyncHelp(mode))
    }
    return
  }

  if (firstArg === 'graph') {
    try {
      const graphTail = args.slice(1)
      let kbStorageDir: string
      try {
        kbStorageDir = await resolveKbStorageDirFromArgs(graphTail)
      } catch {
        out.error(formatPrerequisiteError(CLI_ERROR_NO_KB_BASE))
        return
      }
      const opts = parseGraphCommand(stripCliFlagWithValue(graphTail, '--base'), mode)
      await runGraphCommand(kbStorageDir, opts, out, undefined, mode)
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

  if (firstArg === 'skills') {
    const subcommand = args[1]
    if (subcommand === 'install') {
      try {
        const [skillResults, profileResults, hookResults, mcpResults] = await Promise.all([
          installSkillsGlobally(),
          installSkillIntoProject(),
          installHooks(),
          installMcpConfigs(),
        ])
        out.log(formatSkillInstallReport(skillResults, profileResults, hookResults, mcpResults))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
      }
    } else if (subcommand === 'uninstall') {
      try {
        const [results, hookResults, mcpResults] = await Promise.all([
          uninstallSkills(),
          uninstallHooks(),
          uninstallMcpConfigs(),
        ])
        const report = formatSkillUninstallReport(results, hookResults, mcpResults)
        if (report) out.log(report)
        else out.log('No KB skill files found to remove.')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
      }
    } else {
      out.log(
        [
          'Usage: kb skills <subcommand>',
          '',
          'Manage the bundled KB agent skills for Claude, Cursor, Codex, and Copilot.',
          '',
          'Subcommands:',
          '  install     Install the skill files for each agent CLI and update the core',
          '              agent readmes (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) + kb-first hook',
          '              + sync Cursor/Claude MCP `kb` entries to the current server URL',
          '  uninstall   Remove the installed skill files, readme entries, hook, and MCP entries',
        ].join('\n')
      )
    }
    return
  }

  if (firstArg === 'uninstall') {
    await runUninstallCommand(args.slice(1), out)
    return
  }

  if (isIntentCommand(firstArg)) {
    const reportHost = resolveReportHost(config)
    const reporter = new ReportWriter(defaultLogsDir())
    let collector = new RunCollector(firstArg, { sessionId, host: reportHost })
    const printer = createPrinter(out, mode)
    try {
      let parsed = parseIntentCommand(args)
      if (parsed.envelope.intent === 'query_truth' && resolveFactRetrievalMethod(config) === 'all_facts') {
        parsed = {
          ...parsed,
          allFacts: true,
          envelope: { ...parsed.envelope, payload: { ...parsed.envelope.payload, allFacts: true } },
        }
      }
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
      collector = new RunCollector(firstArg, {
        sessionId,
        base: path.basename(intentBaseDir),
        host: reportHost,
      })
      const rawLlmProvider = createLLMProviderFromConfig(config)
      const llmCounter = rawLlmProvider ? new TokenCountingProvider(rawLlmProvider) : undefined
      const llmProvider = llmCounter ?? rawLlmProvider
      const preRewritePayload = parsed.envelope.payload as { query?: string }
      const preRewriteQueryTruth =
        parsed.envelope.intent === 'query_truth' && typeof preRewritePayload.query === 'string'
          ? preRewritePayload.query.trim()
          : ''
      let graphRelationContext: string | undefined
      /** Chat never reads `query-session.json`; default `kb query` must not either (poisoned rewrites). */
      const querySessionDir =
        parsed.useQuerySession === true && parsed.envelope.intent === 'query_truth'
          ? intentBaseDir
          : undefined
      printer.startSpinner('running intent rewrite...')
      try {
        parsed = await rewriteIntentInputWithSessionContext(
          parsed,
          llmProvider ?? undefined,
          querySessionDir
        )
      } finally {
        printer.stopSpinner()
      }
      const synthesisQuestion =
        parsed.envelope.intent === 'query_truth' ? getIntentQuestion(parsed).trim() : ''
      if (parsed.envelope.intent === 'query_truth' && !parsed.allFacts) {
        const payload = parsed.envelope.payload as { query?: string }
        const originalQuery = typeof payload.query === 'string' ? payload.query.trim() : ''
        if (originalQuery) {
          try {
            const db = new DatabaseSync(kbIndexDbPath(intentBaseDir), { readOnly: true })
            try {
              payload.query =
                isEnvTrue(process.env.KB_ABLATE_NO_EXPANSION)
                  ? originalQuery
                  : expandQueryWithGraph(originalQuery, db)
              for (const qRel of [preRewriteQueryTruth, originalQuery]) {
                if (!qRel) continue
                try {
                  const block = formatGraphRelationBlockFromQuestion(db, qRel)
                  if (block) {
                    graphRelationContext = block
                    break
                  }
                } catch {
                  // Relation-path block is best-effort; never block query.
                }
              }
            } finally {
              db.close()
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            out.error(`[kb-graph] query augmentation unavailable: ${message}`)
          }
        }
      }
      const toolExecutor = createKBToolsRegistry(intentBaseDir, config, {
        taskProvider: llmProvider ?? undefined,
      })
      printer.startSpinner('running intent loop...')
      let aligned = await runQueryTruthRetrieval({
        parsed,
        toolExecutor,
        llmProvider: llmProvider ?? undefined,
        kbStorageDir: intentBaseDir,
        collector,
      }).finally(() => {
        printer.stopSpinner()
      })

      // LLM-driven graph RAG: extract entities from query, re-rank retrieved facts by graph connectivity.
      if (
        parsed.envelope.intent === 'query_truth' &&
        llmProvider &&
        isReadFactsResult(aligned) &&
        !parsed.allFacts
      ) {
        try {
          const rerankerQuery = preRewriteQueryTruth
          const entities = await llmExtractQueryEntities(rerankerQuery, llmProvider)
          if (entities.length > 0) {
            const db = new DatabaseSync(kbIndexDbPath(intentBaseDir), { readOnly: true })
            try {
              const data = (aligned.data ?? {}) as ReadDocumentsResultData
              const reranked = rerankByGraphConnectivity(
                Array.isArray(data.results) ? data.results : [],
                entities,
                db
              )
              aligned = { ...aligned, data: { ...data, results: reranked } }
            } finally {
              db.close()
            }
          }
        } catch {
          // re-ranking is best-effort; never block the answer
        }
      }

      // Flush any tokens accumulated during the intent loop and graph extraction.
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

      // One-shot synthesis with capped fact text (chat agent loop is kb chat only).
      let enriched = aligned
      if (llmProvider && isReadFactsResult(aligned) && preRewriteQueryTruth) {
        const enrichStarted = Date.now()
        // Stream the model's reasoning as a transient "loading" line while it synthesizes
        // the answer; it clears as soon as the answer is ready.
        // Stream reasoning only in interactive terminals — in eval/CI, thinking tokens
        // compete with visible output under Gemini's shared maxOutputTokens budget.
        const onReasoning = process.stderr.isTTY ? createReasoningProgressSink(printer) : undefined
        enriched = await enrichReadDocumentsAnswerWithLLM(
          parsed,
          aligned,
          llmProvider,
          querySessionDir,
          undefined,
          {
            graphRelationContext,
            synthesisQuestion: synthesisQuestion || preRewriteQueryTruth,
            onReasoning,
          }
        ).finally(() => {
          printer.clearProgress()
        })

        if (llmCounter) {
          const enrichTokens = llmCounter.getAndReset()
          if (enrichTokens.inputTokens > 0 || enrichTokens.outputTokens > 0) {
            collector.addStage({
              stage: `${parsed.envelope.intent}:answer-enrichment`,
              startedAt: new Date().toISOString(),
              durationMs: Date.now() - enrichStarted,
              inputTokens: enrichTokens.inputTokens,
              outputTokens: enrichTokens.outputTokens,
              estimatedCostUsd: estimateCost(
                llmProvider.name,
                llmProvider.model,
                enrichTokens.inputTokens,
                enrichTokens.outputTokens
              ),
              provider: llmProvider.name,
              model: llmProvider.model,
            })
          }
        }
      }

      printIntentResult(enriched, printer, {
        verbose: parsed.verbose,
      })
      // Persist the per-hop retrieval timeline (passes, hops, curator drops) so downstream
      // tooling (the eval harness) can reconstruct where a query spent its effort.
      if (isReadFactsResult(enriched)) {
        const retrievalData = (enriched.data as ReadDocumentsResultData | undefined)?.retrieval
        if (retrievalData) {
          collector.setRetrievalTrace(summarizeQueryRetrievalTrace(retrievalData))
        }
      }
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
  const rawArgv = process.argv.slice(2)
  const isTTY = Boolean(process.stdout.isTTY)

  if (rawArgv.includes('--version') || rawArgv.includes('-V')) {
    console.log(`kb v${KB_VERSION}`)
    return
  }

  const { args, host } = parseGlobalCliFlags(rawArgv)
  if (host) applyHostCliOverride(host)

  await migrateLegacyKbSessionJson()

  // Launch TUI when invoked interactively with no arguments
  if (isTTY && args.length === 0) {
    const [skillResults] = await Promise.all([
      installSkillsGlobally().catch(() => [] as Awaited<ReturnType<typeof installSkillsGlobally>>),
    ])
    const isFreshInstall = isFreshClientInstall()
    let kbConfig = await ensureDefaultConfig()
    const inferred = await persistInferredLLMProvider({ config: kbConfig })
    kbConfig = inferred.config
    applyConfigToEnv(kbConfig)
    // After env is applied so MCP URL matches the same profile as the CLI/TUI.
    void syncKbMcpConfigs(kbConfig).catch(() => {})

    const startupNotices: string[] = []
    if (inferred.notice) startupNotices.push(inferred.notice)

    for (const r of skillResults) {
      if (r.action === 'installed') startupNotices.push(`✓ KB skill ${r.skill} installed for ${r.agent}`)
      else if (r.action === 'updated') startupNotices.push(`↑ KB skill ${r.skill} updated for ${r.agent}`)
    }

    if (isFreshInstall) {
      startupNotices.push(FIRST_RUN_WELCOME_NOTICE)
      await markClientInitialized()
    }

    const hasApiKey =
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY
    // A thin client talking to a remote kb-server synthesizes server-side, so it needs no
    // local provider key. Only warn when running in-process (local mode).
    if (!hasApiKey && !shouldUseRemoteServer()) {
      startupNotices.push(
        [
          '⚠  No LLM API key detected. KB needs one of:',
          '     export ANTHROPIC_API_KEY=<your-key>   # Anthropic Claude',
          '     export OPENAI_API_KEY=<your-key>       # OpenAI',
          '     export GEMINI_API_KEY=<your-key>       # Google Gemini',
          '   Set the key in your shell profile, then restart your terminal.',
        ].join('\n')
      )
    }

    const serverHost = formatServerAddress(resolveServerConnection(kbConfig))
    let sessionBase: string | undefined
    try {
      sessionBase = (await resolveEffectiveBaseDir()).baseName
    } catch {
      // no base selected yet
    }
    startupNotices.unshift(formatConnectionContext(kbConfig, sessionBase))
    const { launchTui } = await import('../tui/index.js')
    await launchTui(kbConfig, { startupNotices, serverHost })
    return
  }

  if (isHelpOnlyInvocation(args)) {
    console.log(`🤖 KB Agent Harness v${KB_VERSION}\n`)
    await runMainWithOutput(args, defaultCliOutput, {} as KbConfig)
    return
  }

  installSkillsGlobally().catch(() => {}) // fire and forget — never block startup
  let kbConfig = await ensureDefaultConfig()
  const inferred = await persistInferredLLMProvider({ config: kbConfig })
  kbConfig = inferred.config
  applyConfigToEnv(kbConfig)
  // Keep Cursor/Claude MCP `kb` URL aligned with this process's connection profile.
  syncKbMcpConfigs(kbConfig).catch(() => {})

  // One-shot CLI path — skip banner when docs generate --output json (stdout must be parseable JSON only).
  const machineJsonStdout = isDocsGenerateJsonOutputArgs(args)
  if (!machineJsonStdout) {
    console.log(`🤖 KB Agent Harness v${KB_VERSION}\n`)
    if (inferred.notice) {
      console.log(inferred.notice)
      console.log('')
    }
    let cliBase: string | undefined
    try {
      cliBase = (await resolveEffectiveBaseDir()).baseName
    } catch {
      // no base yet
    }
    console.log(formatConnectionContext(kbConfig, cliBase))
    console.log('')
  } else if (inferred.notice) {
    console.error(inferred.notice)
    console.error('')
  }
  await runMainWithOutput(args, defaultCliOutput, kbConfig)
}

function isHelpOnlyInvocation(args: string[]): boolean {
  if (args.length === 0) return false
  return args.includes('--help') || args.includes('-h') || args[0] === 'help' || args[1] === 'help'
}

main().catch(error => {
  // Connection errors and other thrown failures must exit non-zero so scripts/CI/eval can
  // detect them. Print the clean message (KbConnectionError's message is the full hint),
  // in red — errors shown to the user are always styled as errors.
  console.error(chalk.red(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
