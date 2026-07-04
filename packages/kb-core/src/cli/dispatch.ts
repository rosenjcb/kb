/**
 * Server-side kb command dispatch — runs indexing, docs, facts, graph, logs, etc.
 * against the server's KB_HOME. Invoked by POST /v1/admin/cli.
 */
import {
  ReportWriter,
  RunCollector,
  defaultLogsDir,
} from '@kb/core/core/telemetry.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { type CmdMode, cmd } from '@kb/core/config/cmd-ref.js'
import {
  initCancelledNotice,
} from '@kb/core/config/cli-prerequisites.js'
import { baseNameFromGitUrl } from '@kb/core/ops/git-sync.js'
import { isInitCancelledError, parseInitCommand, runKbInit } from '@kb/core/ops/init-cli.js'
import { runScanCommand } from '@kb/core/ops/scan-command.js'
import {
  deleteBase,
  ensureOperationalBaseDir,
  formatDeleteBaseResult,
  listAllBases,
  resolveEffectiveBaseDir,
  resolveKbStorageDirFromArgs,
  stripCliFlagWithValue,
} from '@kb/core/storage/base-selection.js'
import {
  DocsDeleteError,
  parseDocsDeleteCommand,
  runDocsDelete,
} from '@kb/core/cli/docs-delete-cli.js'
import {
  DocsGenerateError,
  formatDocsGenerateHumanOutput,
  isDocsGenerateJsonOutputArgs,
  parseDocsGenerateCommand,
  runDocsGenerate,
} from '@kb/core/cli/docs-generate-cli.js'
import {
  DocsRenameError,
  parseDocsRenameCommand,
  runDocsRename,
} from '@kb/core/cli/docs-rename-cli.js'
import { FactsCommandError, runFactsCommand } from '@kb/core/cli/facts-cli.js'
import {
  GraphCommandError,
  parseGraphCommand,
  printGraphHelp,
  runGraphCommand,
} from '@kb/core/cli/graph-cli.js'
import { runLogsCommand } from '@kb/core/cli/logs-cli.js'
import { parsePublishCommand, runPublishCommand } from '@kb/core/cli/publish-cli.js'
import { runIgnoreCommand, runRepoCommand } from '@kb/core/cli/repo-cli.js'
import {
  ViewCommandError,
  runListCommand,
  runViewCommand,
} from '@kb/core/cli/view-cli.js'
import {
  printBaseDeleteHelp,
  printBaseHelp,
  printCliHelp,
  printDocsHelp,
  printInitHelp,
  printLogsHelp,
  printScanHelp,
} from '@kb/core/cli/help.js'
import type { CliOutput } from '@kb/core/ui/cli-output.js'
import { createCaptureOutput } from '@kb/core/cli/capture-output.js'

export interface ServerCommandResult {
  exitCode: number
  output: string
}

export interface ServerCommandOptions {
  config: KbConfig
  mode?: CmdMode
  sessionId?: string
}

export async function runServerCommand(
  args: string[],
  options: ServerCommandOptions,
): Promise<ServerCommandResult> {
  const capture = createCaptureOutput()
  const exitCode = await runServerCommandWithOutput(args, capture.output, options)
  const output = [capture.text(), capture.errorText()].filter(Boolean).join('\n')
  return { exitCode, output }
}

export async function runServerCommandWithOutput(
  args: string[],
  out: CliOutput,
  options: ServerCommandOptions,
): Promise<number> {
  const mode = options.mode ?? 'cli'
  const config = options.config
  const sessionId = options.sessionId
  const firstArg = args[0]

  if (args.length === 0 || firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    out.log(printCliHelp(mode))
    return 0
  }

  if (firstArg === 'query' || firstArg === 'chat') {
    out.error('Use POST /v1/query or POST /v1/chat for query and chat in remote mode.')
    return 1
  }

  if (firstArg === 'config' || firstArg === 'skills' || firstArg === 'uninstall' || firstArg === 'sync') {
    out.error(`\`${firstArg}\` runs on the kb client, not the server.`)
    return 1
  }

  if (firstArg === 'base') {
    return runServerBaseCommand(args.slice(1), out, mode)
  }

  if (firstArg === 'init') {
    if (args.includes('--help') || args.includes('-h') || args[1] === 'help') {
      out.log(printInitHelp(mode))
      return 0
    }
    const reporter = new ReportWriter(defaultLogsDir())
    const collector = new RunCollector('init', { sessionId })
    try {
      const parsed = parseInitCommand(args.slice(1))
      const initCollector = new RunCollector('init', { sessionId })
      if (!parsed.base && parsed.gitTargets && parsed.gitTargets.length > 0) {
        parsed.base = baseNameFromGitUrl(parsed.gitTargets[0].url)
      }
      const result = await runKbInit({
        ...parsed,
        collector: initCollector,
        progressSink: line => out.log(line),
      })
      out.log(JSON.stringify(result, null, 2))
      await reporter.append(initCollector.finish('success', undefined, result.base))
      return 0
    } catch (error) {
      if (isInitCancelledError(error)) {
        let baseName: string | undefined
        try {
          baseName = (await resolveEffectiveBaseDir()).baseName
        } catch {
          baseName = undefined
        }
        await reporter.append(collector.finish('success', undefined, baseName))
        out.log(initCancelledNotice(baseName))
        return 0
      }
      const message = error instanceof Error ? error.message : String(error)
      await reporter.append(collector.finish('error', message))
      out.error(`❌ ${message}`)
      return 1
    }
  }

  if (firstArg === 'scan') {
    if (args.includes('--help') || args.includes('-h') || args[1] === 'help') {
      out.log(printScanHelp(mode))
      return 0
    }
    const reporter = new ReportWriter(defaultLogsDir())
    const collector = new RunCollector('scan', { sessionId })
    try {
      const summary = await runScanCommand(args.slice(1), line => out.log(line))
      out.log(summary)
      await reporter.append(collector.finish('success', undefined))
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await reporter.append(collector.finish('error', message))
      out.error(`❌ ${message}`)
      return 1
    }
  }

  if (firstArg === 'logs') {
    try {
      out.log(await runLogsCommand(args.slice(1)))
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('kb logs')) {
        out.log(message)
        return 0
      }
      out.error(`❌ ${message}`)
      out.log(printLogsHelp(mode))
      return 1
    }
  }

  if (firstArg === 'publish') {
    const provider = args[1]
    if (!provider || provider.startsWith('--')) {
      out.error('Usage: kb publish <notion> [options]')
      return 1
    }
    try {
      if (provider === 'notion') {
        const parsed = parsePublishCommand(args.slice(2))
        const result = await runPublishCommand({
          ...parsed,
          progressSink: line => out.log(line.trimEnd()),
        })
        out.log(JSON.stringify(result, null, 2))
        return 0
      }
      out.error(`Unknown provider "${provider}". Usage: kb publish <notion> [options]`)
      return 1
    } catch (error) {
      out.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  if (firstArg === 'facts') {
    try {
      out.log(await runFactsCommand(args.slice(1), { cwd: process.cwd() }))
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof FactsCommandError ? error.exitCode : 1
      if (code === 0) {
        out.log(message)
        return 0
      }
      out.error(`❌ ${message}`)
      return code
    }
  }

  if (firstArg === 'docs') {
    return runServerDocsCommand(args.slice(1), out, config, mode)
  }

  if (firstArg === 'graph') {
    try {
      const graphTail = args.slice(1)
      let kbStorageDir: string
      try {
        kbStorageDir = await resolveKbStorageDirFromArgs(stripCliFlagWithValue(graphTail, '--base'))
      } catch {
        out.error('No KB base configured on the server.')
        return 1
      }
      const opts = parseGraphCommand(graphTail, mode)
      await runGraphCommand(kbStorageDir, opts, out, undefined, mode)
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof GraphCommandError && error.exitCode === 0) {
        out.log(message)
        return 0
      }
      out.error(`❌ ${message}`)
      if (!(error instanceof GraphCommandError)) {
        out.error(printGraphHelp(mode))
      }
      return error instanceof GraphCommandError ? error.exitCode : 1
    }
  }

  out.error(`Unknown command: ${firstArg}\n\n${printCliHelp(mode)}`)
  return 1
}

async function runServerBaseCommand(
  subArgs: string[],
  out: CliOutput,
  mode: CmdMode,
): Promise<number> {
  const subCmd = subArgs[0]

  if (subCmd === '--help' || subCmd === '-h' || subCmd === 'help') {
    out.log(printBaseHelp(mode))
    return 0
  }

  if (subCmd === 'use') {
    out.error('`base use` updates the client connection profile — run it with the kb client, not via the server.')
    return 1
  }

  if (!subCmd || subCmd === 'list') {
    const lines: string[] = ['KB bases (server)']
    const bases = await listAllBases()
    if (bases.length === 0) {
      lines.push('No initialized bases found.')
      lines.push(`  Run \`${cmd('init --base <name>', mode)}\` on the server.`)
    } else {
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
    return 0
  }

  if (subCmd === 'delete') {
    const deleteArgs = subArgs.slice(1)
    if (deleteArgs.includes('--help') || deleteArgs.includes('-h') || deleteArgs[0] === 'help') {
      out.log(printBaseDeleteHelp(mode))
      return 0
    }
    const base = deleteArgs.find(token => !token.startsWith('--'))
    if (!base) {
      out.error(printBaseDeleteHelp(mode))
      return 1
    }
    const force = deleteArgs.includes('--force') || deleteArgs.includes('-f')
    if (!force) {
      out.error(`Server requires --force to delete a base: ${cmd(`base delete ${base} --force`, mode)}`)
      return 1
    }
    const result = await deleteBase(base)
    out.log(formatDeleteBaseResult(base, result, mode))
    return 0
  }

  if (subCmd === 'repo') {
    try {
      const result = await runRepoCommand(subArgs.slice(1), {
        mode,
        onProgress: line => out.log(line),
      })
      out.log(result.output)
      return 0
    } catch (error) {
      out.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  if (subCmd === 'ignore') {
    try {
      const result = await runIgnoreCommand(subArgs.slice(1), { mode })
      out.log(result.output)
      return 0
    } catch (error) {
      out.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }

  out.error(`Unknown base subcommand: ${subCmd}\n\n${printBaseHelp(mode)}`)
  return 1
}

async function runServerDocsCommand(
  args: string[],
  out: CliOutput,
  config: KbConfig,
  mode: CmdMode,
): Promise<number> {
  const docsAction = args[0]

  if (!docsAction || docsAction === '--help' || docsAction === '-h' || docsAction === 'help') {
    out.log(printDocsHelp(mode))
    return 0
  }

  if (docsAction === 'view') {
    try {
      const result = await runViewCommand(args.slice(1))
      out.write(result.output)
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof ViewCommandError ? error.exitCode : 1
      if (code === 0) {
        out.log(message)
        return 0
      }
      out.error(`❌ ${message}`)
      return code
    }
  }

  if (docsAction === 'list') {
    try {
      const result = await runListCommand(args.slice(1))
      out.write(result.output)
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof ViewCommandError ? error.exitCode : 1
      if (code === 0) {
        out.log(message)
        return 0
      }
      out.error(`❌ ${message}`)
      return code
    }
  }

  if (docsAction === 'generate') {
    const jsonOut = isDocsGenerateJsonOutputArgs(['docs', 'generate', ...args.slice(1)])
    try {
      const parsed = parseDocsGenerateCommand(args.slice(1))
      const generated = await runDocsGenerate(parsed, process.cwd(), config)
      const payload = { status: 'accepted' as const, generated }
      if (parsed.outputFormat === 'json') {
        out.log(JSON.stringify(payload))
      } else {
        out.log(formatDocsGenerateHumanOutput(generated))
      }
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof DocsGenerateError ? error.exitCode : 1
      if (code === 0) {
        out.log(message)
        return 0
      }
      if (jsonOut) {
        out.log(JSON.stringify({ status: 'error', message }))
      } else {
        out.error(`❌ ${message}`)
      }
      return code
    }
  }

  if (docsAction === 'delete') {
    try {
      const parsed = parseDocsDeleteCommand(args.slice(1))
      const deleteBaseDir = parsed.base
        ? await ensureOperationalBaseDir(parsed.base)
        : (await resolveEffectiveBaseDir()).baseDir
      await runDocsDelete(parsed, deleteBaseDir, out)
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof DocsDeleteError ? error.exitCode : 1
      if (code === 0) {
        out.log(message)
        return 0
      }
      out.error(`❌ ${message}`)
      return code
    }
  }

  if (docsAction === 'rename') {
    try {
      const parsed = parseDocsRenameCommand(args.slice(1))
      const renameBaseDir = parsed.base
        ? await ensureOperationalBaseDir(parsed.base)
        : (await resolveEffectiveBaseDir()).baseDir
      await runDocsRename(parsed, renameBaseDir, out)
      return 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof DocsRenameError ? error.exitCode : 1
      if (code === 0) {
        out.log(message)
        return 0
      }
      out.error(`❌ ${message}`)
      return code
    }
  }

  out.error(`❌ Unknown docs action: ${docsAction}`)
  out.error(printDocsHelp(mode))
  return 1
}
