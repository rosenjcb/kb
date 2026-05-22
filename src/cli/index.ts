#!/usr/bin/env node

/**
 * KB Agent Harness CLI
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  ReportWriter,
  RunCollector,
  TokenCountingProvider,
  defaultLogsDir,
  estimateCost,
} from '../core/telemetry'
import Database from 'better-sqlite3'
import { expandQueryWithGraph, kbIndexDbPath } from '../tools/graph-query-expansion'
import { formatGraphRelationBlockFromQuestion } from '../tools/graph-relation-context'
import { createKBToolsRegistry } from '../tools/kb-tools-registry'
import { createPrinter } from '../ui/printer'
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
} from './base-selection'
import {
  CLI_ERROR_NO_KB_BASE,
  formatPrerequisiteError,
} from './cli-prerequisites'
import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from './cmd-ref'
import { printConfigHelp, runConfigCommand } from './config-cli'
import {
  DocsDeleteError,
  parseDocsDeleteCommand,
  printDocsDeleteHelp,
  runDocsDelete,
} from './docs-delete-cli'
import {
  DocsGenerateError,
  formatDocsGenerateHumanOutput,
  isDocsGenerateJsonOutputArgs,
  parseDocsGenerateCommand,
  printDocsGenerateHelp,
  runDocsGenerate,
} from './docs-generate-cli'
import {
  DocsRenameError,
  parseDocsRenameCommand,
  printDocsRenameHelp,
  runDocsRename,
} from './docs-rename-cli'
import { ensurePythonEnv } from '../core/fact-categories'
import { FactsCommandError, runFactsCommand } from './facts-cli'
import { GraphCommandError, parseGraphCommand, printGraphHelp, runGraphCommand } from './graph-cli'
import { parseInitCommand, parseScanCommand, runKbInit } from './init-cli'
import {
  isIntentCommand,
  isReadFactsResult,
  parseIntentCommand,
  printIntentHelp,
  printIntentResult,
  rewriteIntentInputWithSessionContext,
  type ReadDocumentsResultData,
} from './intent-cli'
import { normalizeReadResult, runChatSynthesis } from './chat-cli'
import {
  llmExtractQueryEntities,
  rerankByGraphConnectivity,
} from '../tools/graph-rag-reranker'
import {
  applyConfigToEnv,
  createLLMProviderFromConfig,
  ensureDefaultConfig,
  persistInferredLLMProvider,
  resolveFactRetrievalMethod,
} from './kb-config'
import type { KbConfig } from './kb-config'
import { printLogsHelp, runLogsCommand } from './logs-cli'
import { parsePublishCommand, runPublishCommand } from './publish-cli'
import { parseJekyllPublishOptions, runJekyllPublish } from './publish-jekyll'
import { runQueryTruthRetrieval } from './query-truth-retrieval'
import {
  formatSkillInstallReport,
  formatSkillUninstallReport,
  installSkillIntoProject,
  installSkillsGlobally,
  uninstallSkills,
} from './skill-installer'
import { printSyncHelp, runSyncCommand } from './sync-cli'
import {
  ViewCommandError,
  printListHelp,
  printViewHelp,
  runListCommand,
  runViewCommand,
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
    '  kb',
    `  ${cmd('<command>', mode)} [options]`,
    `  ${cmd('<intent-command>', mode)} "<input>" [options]`,
    '',
    'Core commands:',
    '  base        Manage KB bases (use, delete)',
    '  config      Inspect or update persistent config',
    '  init        Build a KB from the current repo',
    '  scan        Refresh a KB with content from the current repo',
    '  graph       Inspect or edit the knowledge graph',
    '  docs        Browse KB documents',
    '  facts       List, search, or show KB facts',
    '  publish     Publish KB docs',
    '  sync        Install the latest published KB release',
    '  logs        Browse and compare run reports',
    '  skills      Manage agent skills',
    '',
    'Intent commands:',
    '  query       Search the knowledge base',
    '  submit      Store a fact or checkpoint',
    '  invalidate  Remove or replace stale KB facts',
    '',
    cmdHelpHint(mode),
    '',
    'Examples:',
    `  ${cmd('init --base dogfood', mode)}`,
    `  ${cmd('scan --base dogfood', mode)}`,
    `  ${cmd('base use dogfood', mode)}`,
    `  ${cmd('scan', mode)}`,
    `  ${cmd('sync', mode)}`,
    `  ${cmd('base use --default dogfood', mode)}`,
    `  ${cmd('base delete ci-test --force', mode)}`,
    `  ${cmd('docs list --base dogfood', mode)}`,
    `  ${cmd('docs view kb-base-selection-and-usage', mode)}`,
    `  ${cmd('submit "SQLite hybrid search is enabled in dogfood"', mode)}`,
  ].join('\n')
}

function printInitHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('init', mode)} command`,
    '',
    'Usage:',
    `  ${cmd('init', mode)} [--base <name>] [--detach | --resume] [--stop-after <cycle>]`,
    '',
    'Flags:',
    '  --base <name>                   Choose the KB base to initialize',
    '  --non-interactive              Skip interview prompts when possible',
    '  --detach                       Pause after the current cycle and save a checkpoint',
    '  --resume                       Resume from the latest init checkpoint',
    '  --stop-after <cycle>           Stop after read-inputs|code-index|document-facts|import-docs|write',
    '  --debug                        Emit debug logging and telemetry details',
    '',
    'Notes:',
    '  Without --base, interactive init prompts for a fresh base name and switches the active base immediately.',
    `  Use ${cmd('scan', mode)} to refresh a base with content from this repo or from related repos.`,
    '',
    'Examples:',
    `  ${cmd('init --base dogfood', mode)}`,
    `  ${cmd('init --base dogfood --detach', mode)}`,
    `  ${cmd('init --base dogfood --resume', mode)}`,
  ].join('\n')
}

function printScanHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('scan', mode)} command`,
    '',
    'Usage:',
    `  ${cmd('scan', mode)} [--base <name>] [--non-interactive]`,
    '',
    'Flags:',
    '  --base <name>                   Choose which existing KB base to refresh',
    '  --non-interactive              Skip any interactive questions when possible',
    '  --debug                        Emit debug logging and telemetry details',
    '',
    'Notes:',
    '  Scan re-reads markdown/text sources under the current repo, refreshes original docs, and applies the resulting KB mutations.',
    '  Without --base, scan uses the active base first, then the default base.',
    '  A common workflow is to run `kb init` in a primary repo, then run `kb scan` in related repos into that same base.',
    `  In the TUI, use ${cmd('base use <base>', mode)} and then ${cmd('scan', mode)} in each related repo.`,
    '',
    'Examples:',
    `  ${cmd('scan --base dogfood', mode)}`,
    `  ${cmd('base use dogfood', mode)}`,
    `  ${cmd('scan', mode)}`,
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
    'Examples:',
    `  ${cmd('base', mode)}`,
    `  ${cmd('base list', mode)}`,
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

  if (args.length === 0 || firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    out.log(printCliHelp(mode))
    return
  }

  if (firstArg === 'base' || firstArg === 'use') {
    // `kb use ...` is a deprecated alias for `kb base use ...`
    // Normalize: if the user typed `kb use <args>`, treat it as `kb base use <args>`
    const subArgs = firstArg === 'use' ? ['use', ...args.slice(1)] : args.slice(1)
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
        lines.push('No initialized bases found.')
        lines.push(`  Run \`${cmd('init --base <name>', mode)}\` to create one.`)
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
        return
      }

      const baseDir = resolveBaseToDir(base)
      const sqlitePath = path.join(baseDir, '.kb-index.sqlite')
      try {
        await stat(sqlitePath)
      } catch {
        out.error(`Base "${base}" has not been initialized. Run: kb init --base ${base}`)
        return
      }

      await writeSessionBase(base)
      const resolved = await ensureOperationalBaseDir(base)
      if (makeDefault) {
        await writeDefaultBase(base)
        out.log(formatDefaultCommandHelp(base, resolved, mode))
        return
      }
      out.log(formatUseCommandHelp(base, resolved, mode))
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

  if (firstArg === 'default') {
    const base = args[1]
    if (base === '--show' || !base) {
      const configured = await readBaseConfig()
      if (!configured.defaultBase) {
        out.log('No default base configured.')
        out.log(`  Set one with: ${cmd('base use --default <base>', mode)}`)
        return
      }
      const resolved = await ensureOperationalBaseDir(configured.defaultBase)
      out.log(`Default base: ${configured.defaultBase}`)
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
    const resolved = await ensureOperationalBaseDir(saved.defaultBase ?? base)
    out.log(formatDefaultCommandHelp(saved.defaultBase ?? base, resolved, mode))
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

  if (firstArg === 'view') {
    out.error(`❌ \`${cmd('view', mode)}\` has moved to \`${cmd('docs view', mode)}\`.`)
    return
  }

  if (firstArg === 'list') {
    const treatAsLogsList = args
      .slice(1)
      .some(arg => ['--since', '--command', '--limit'].includes(arg))
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
    if (args.includes('--help') || args.includes('-h') || args[1] === 'help') {
      out.log(printInitHelp(mode))
      return
    }
    const reporter = new ReportWriter(defaultLogsDir())
    const collector = new RunCollector('init', { sessionId })
    try {
      const parsed = parseInitCommand(args.slice(1))
      if (parsed.rescan) {
        out.log(
          `⚠️  ${cmd('init --rescan', mode)} has moved to ${cmd('scan', mode)}. Continuing for compatibility.`
        )
      }
      const initCollector = new RunCollector('init', { debug: parsed.debug, sessionId })
      const result = await runKbInit({ ...parsed, collector: initCollector })
      out.log(JSON.stringify(result, null, 2))
      await reporter.append(initCollector.finish('success', undefined, result.base))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await reporter.append(collector.finish('error', message))
      out.error(`❌ ${message}`)
    }
    return
  }

  if (firstArg === 'scan') {
    if (args.includes('--help') || args.includes('-h') || args[1] === 'help') {
      out.log(printScanHelp(mode))
      return
    }
    const reporter = new ReportWriter(defaultLogsDir())
    const collector = new RunCollector('scan', { sessionId })
    try {
      const parsed = parseScanCommand(args.slice(1))
      const scanCollector = new RunCollector('scan', { debug: parsed.debug, sessionId })
      const result = await runKbInit({ ...parsed, collector: scanCollector })
      out.log(JSON.stringify(result, null, 2))
      await reporter.append(scanCollector.finish('success', undefined, result.base))
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
        const [skillResults, profileResults] = await Promise.all([
          installSkillsGlobally(),
          installSkillIntoProject(),
        ])
        out.log(formatSkillInstallReport(skillResults, profileResults))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
      }
    } else if (subcommand === 'uninstall') {
      try {
        const results = await uninstallSkills()
        const report = formatSkillUninstallReport(results)
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
          'Subcommands:',
          '  install     Inject KB skills into ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md',
          '  uninstall   Remove KB skill files and profile MD entries',
        ].join('\n')
      )
    }
    return
  }

  if (isIntentCommand(firstArg)) {
    const reporter = new ReportWriter(defaultLogsDir())
    let collector = new RunCollector(firstArg, { sessionId })
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
      collector = new RunCollector(firstArg, { debug: parsed.debug, sessionId, base: path.basename(intentBaseDir) })
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
      if (parsed.envelope.intent === 'query_truth' && !parsed.allFacts) {
        const payload = parsed.envelope.payload as { query?: string }
        const originalQuery = typeof payload.query === 'string' ? payload.query.trim() : ''
        if (originalQuery) {
          try {
            const db = new Database(kbIndexDbPath(intentBaseDir), { readonly: true })
            try {
              payload.query = expandQueryWithGraph(originalQuery, db)
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
            const db = new Database(kbIndexDbPath(intentBaseDir), { readonly: true })
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

      // Synthesize answer using the chat pipeline (multi-round agentic LLM).
      let enriched = aligned
      if (llmProvider && isReadFactsResult(aligned) && preRewriteQueryTruth) {
        const retrieval = normalizeReadResult(aligned.data)
        const synthesis = await runChatSynthesis({
          question: preRewriteQueryTruth,
          retrieval,
          messages: [],
          llmProvider,
          toolExecutor,
          kbStorageDir: intentBaseDir,
          isAllFacts: parsed.allFacts,
          graphRelationBlock: graphRelationContext,
          printer,
        })
        enriched = {
          ...aligned,
          data: { ...(aligned.data as object), answer: synthesis.answer },
        }

        // Capture tokens from the synthesis LLM calls.
        if (llmCounter) {
          const enrichTokens = llmCounter.getAndReset()
          if (enrichTokens.inputTokens > 0 || enrichTokens.outputTokens > 0) {
            collector.addStage({
              stage: `${parsed.envelope.intent}:answer-enrichment`,
              startedAt: new Date().toISOString(),
              durationMs: synthesis.answerMs,
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

      printIntentResult(enriched, parsed.output, printer, {
        verbose: parsed.verbose,
        debug: parsed.debug,
      })
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
  const args = process.argv.slice(2)
  const isTTY = Boolean(process.stdout.isTTY)

  await migrateLegacyKbSessionJson()

  // Launch TUI when invoked interactively with no arguments
  if (isTTY && args.length === 0) {
    const [skillResults] = await Promise.all([
      installSkillsGlobally().catch(() => [] as Awaited<ReturnType<typeof installSkillsGlobally>>),
    ])
    let kbConfig = await ensureDefaultConfig()
    const inferred = await persistInferredLLMProvider({ config: kbConfig })
    kbConfig = inferred.config
    applyConfigToEnv(kbConfig)

    const startupNotices: string[] = []
    if (inferred.notice) startupNotices.push(inferred.notice)

    for (const r of skillResults) {
      if (r.action === 'installed') startupNotices.push(`✓ KB skill ${r.skill} installed for ${r.agent}`)
      else if (r.action === 'updated') startupNotices.push(`↑ KB skill ${r.skill} updated for ${r.agent}`)
    }

    try {
      ensurePythonEnv()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`❌ ${message}\n`)
      process.exit(1)
    }

    const hasApiKey =
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY
    if (!hasApiKey) {
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

    const { launchTui } = await import('../tui/index.js')
    await launchTui(kbConfig, { startupNotices })
    return
  }

  if (isHelpOnlyInvocation(args)) {
    console.log('🤖 KB Agent Harness\n')
    await runMainWithOutput(args, defaultCliOutput, {} as KbConfig)
    return
  }

  installSkillsGlobally().catch(() => {}) // fire and forget — never block startup
  let kbConfig = await ensureDefaultConfig()
  const inferred = await persistInferredLLMProvider({ config: kbConfig })
  kbConfig = inferred.config
  applyConfigToEnv(kbConfig)

  // One-shot CLI path — skip banner when docs generate --output json (stdout must be parseable JSON only).
  const machineJsonStdout = isDocsGenerateJsonOutputArgs(args)
  if (!machineJsonStdout) {
    console.log('🤖 KB Agent Harness\n')
    if (inferred.notice) {
      console.log(inferred.notice)
      console.log('')
    }
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

main().catch(console.error)
