#!/usr/bin/env node

/**
 * KB Agent Harness CLI — thin client. Always talks HTTP to a kb-server host.
 */

import chalk from 'chalk'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { CLIENT_VERSION } from '../version.js'
import {
  ensureOperationalBaseDir,
  formatDefaultCommandHelp,
  formatUseCommandHelp,
  migrateLegacyKbSessionJson,
  readBaseConfig,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  writeDefaultBase,
  writeSessionBase,
} from '@kb/core/storage/base-selection.js'
import {
  CLI_ERROR_NO_KB_BASE,
  uninitializedBaseNotice,
} from '@kb/core/config/cli-prerequisites.js'
import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from '@kb/core/config/cmd-ref.js'
import { isDocsGenerateJsonOutputArgs } from '@kb/core/cli/docs-generate-cli.js'
import {
  applyConfigToEnv,
  ensureDefaultConfig,
  isFreshClientInstall,
  markClientInitialized,
} from '@kb/core/config/kb-config.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
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
import { discoverRemoteDefaultBase, isClientLocalCommand, runRemoteCliCommand } from './remote-commands.js'
import {
  resolveActiveBaseName,
  resolveServerConnection,
  formatServerAddress,
  formatConnectionContext,
} from '../api/server-connection.js'
import { applyConnectionOverrides, parseGlobalCliFlags } from '../api/cli-global-flags.js'
import {
  formatMcpStatusReport,
  formatMcpSyncReport,
  readKbMcpStatus,
  syncKbMcpConfigs,
  uninstallKbMcpConfigs,
} from '../api/mcp-config-sync.js'
import { runUninstallCommand } from './uninstall-cli'

import type { CliOutput } from '@kb/core/ui/cli-output.js'
export type { CliOutput } from '@kb/core/ui/cli-output.js'

const defaultCliOutput: CliOutput = {
  log: msg => console.log(msg),
  error: msg => console.error(msg),
  write: chunk => process.stdout.write(chunk),
}

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
    '  --host <host[:port]|url>   kb-server to use (else KB_HOST env)',
    '  --port <port>              kb-server port, refines --host (else KB_PORT)',
    '  --sslmode <mode>           require|prefer|disable (else KB_SSLMODE, default prefer)',
    '  --api-key <key>            Bearer for the server (alias --key; else KB_SERVER_API_KEY)',
    '  --base <slug>             server-side base to use (sent as X-KB-Base; else KB_BASE)',
    '  --connection-string <uri>  kb://[apikey@]host[:port]/[base][?sslmode=] (else KB_CONNECTION_STRING)',
    '',
    'Core commands:',
    '  base        Manage KB bases (use, delete)',
    '  graph       Inspect or edit the knowledge graph',
    '  entities    Inspect harvested entities (services, surfaces) and name collisions',
    '  docs        Browse KB documents',
    '  facts       List, search, or show KB facts',
    '  publish     Publish KB docs',
    '  sync        Install the latest published KB release',
    '  logs        Browse and compare run reports',
    '  skills      Manage agent skills',
    '  mcp         Install/remove Claude Code + Cursor MCP kb entries',
    '  uninstall   Remove the kb client binary (server/data untouched; see kb-server uninstall)',
    '',
    'Intent commands:',
    '  query       Search the knowledge base',
    '',
    cmdHelpHint(mode),
    '',
    'Examples:',
    mode === 'tui'
      ? `  /query "how does auth work?"`
      : `  kb query "how does auth work?"`,
    mode === 'cli' ? `  kb --host localhost:38117 query "how does auth work?"` : null,
    mode === 'cli' ? `  kb --host localhost:38117 --base raylib query "what is a Vector2?"` : null,
    mode === 'cli'
      ? `  kb --connection-string kb://localhost:38117/raylib?sslmode=disable query "…"`
      : null,
    `  ${cmd('mcp install --host localhost:38117', mode)}`,
    `  ${cmd('mcp install --host https://kb.example.com:38117', mode)}`,
    `  ${cmd('base use dogfood', mode)}`,
    `  ${cmd('sync', mode)}`,
    `  ${cmd('docs list --base dogfood', mode)}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function printMcpHelp(): string {
  return [
    'Usage: kb mcp <subcommand>',
    '',
    'Install or remove the kb MCP entry for Claude Code and Cursor',
    '(localhost or remote). Agents use MCP only; humans use the kb CLI/TUI.',
    '',
    'Subcommands:',
    '  install                              Write mcpServers.kb → ${server}/mcp',
    '                                      Host from the active connection —',
    '                                      --host / --connection-string / --api-key',
    '                                      (or KB_HOST / KB_CONNECTION_STRING /',
    '                                      KB_SERVER_API_KEY), else localhost.',
    '  status                              Show env host + current MCP kb URLs',
    '  uninstall                           Remove managed kb MCP entries',
    '',
    'Examples:',
    '  kb mcp install',
    '  kb mcp install --host localhost:38117',
    '  kb mcp install --host https://kb.example.com:38117 --key <api-key>',
    '  export KB_CONNECTION_STRING=kb://remote:38117 && kb mcp install',
    '  kb mcp status',
    '  kb mcp uninstall',
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

/**
 * Thin-client dispatch: client-local commands stay here; everything else → kb-server.
 */
export async function runMainWithOutput(
  args: string[],
  out: CliOutput,
  config: KbConfig,
  mode: CmdMode = 'cli',
  _sessionId?: string
): Promise<void> {
  const firstArg = args[0]

  if (args.length === 0 || firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    out.log(printCliHelp(mode))
    return
  }

  // Forward server-owned commands (query, docs, facts, graph, logs, publish, base list/delete, …).
  if (!isClientLocalCommand(args)) {
    const code = await runRemoteCliCommand(args, out, config, mode)
    if (code && mode === 'cli') process.exitCode = code
    return
  }

  if (firstArg === 'base') {
    const subArgs = args.slice(1)
    const subCmd = subArgs[0]

    // Only `base use` is client-local; list/delete already forwarded above.
    if (subCmd === '--help' || subCmd === '-h' || subCmd === 'help') {
      out.log(printBaseHelp(mode))
      return
    }

    if (subCmd === 'use') {
      const useArgs = subArgs.slice(1)
      const show = useArgs.includes('--show')
      const makeDefault = useArgs.includes('--default')
      const help = useArgs.includes('--help') || useArgs.includes('-h') || useArgs[0] === 'help'
      const base = useArgs.find(token => !token.startsWith('--'))

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
        out.error(uninitializedBaseNotice(base))
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

    out.error(`Unknown base subcommand: ${subCmd}\n\n${printBaseHelp(mode)}`)
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

  if (firstArg === 'skills') {
    const subcommand = args[1]
    if (subcommand === 'install') {
      try {
        const [skillResults, profileResults, hookResults, mcpResults] = await Promise.all([
          installSkillsGlobally(),
          installSkillIntoProject(),
          installHooks(),
          installMcpConfigs(config),
        ])
        out.log(formatSkillInstallReport(skillResults, profileResults, hookResults, mcpResults))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
        if (mode === 'cli') process.exitCode = 1
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
        if (mode === 'cli') process.exitCode = 1
      }
    } else {
      out.log(
        [
          'Usage: kb skills <subcommand>',
          '',
          'Manage the bundled KB agent skills for Claude, Cursor, Codex, and Copilot.',
          '',
          'Subcommands:',
          '  install     Install skill files, profile readmes, kb-first hook,',
          '              and MCP configs for the active connection (localhost default)',
          '  uninstall   Remove skill files, readme entries, hook, and MCP entries',
          '',
          'Override the MCP host with: kb --host <host|url> skills install',
          '                        or: kb mcp install --host <host|url>',
        ].join('\n')
      )
    }
    return
  }

  if (firstArg === 'mcp') {
    const subcommand = args[1]
    if (subcommand === 'install') {
      try {
        // --host / --api-key / --key / --connection-string / --port / --sslmode /
        // --base are all global flags, already stripped and applied to the ambient
        // connection by `applyConnectionOverrides` before dispatch reached here.
        const extra = args.slice(2)
        if (extra.length > 0) {
          throw new Error(`Unknown argument: ${extra[0]}\n\n${printMcpHelp()}`)
        }
        const results = await syncKbMcpConfigs({ config })
        const report = formatMcpSyncReport(results)
        if (report) out.log(report)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
        if (mode === 'cli') process.exitCode = 1
      }
    } else if (subcommand === 'status') {
      try {
        out.log(formatMcpStatusReport(await readKbMcpStatus()))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
        if (mode === 'cli') process.exitCode = 1
      }
    } else if (subcommand === 'uninstall') {
      try {
        const results = await uninstallKbMcpConfigs()
        const report = formatMcpSyncReport(results)
        if (report) out.log(report)
        else out.log('No KB MCP entries found.')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
        if (mode === 'cli') process.exitCode = 1
      }
    } else {
      out.log(printMcpHelp())
    }
    return
  }

  if (firstArg === 'uninstall') {
    await runUninstallCommand(args.slice(1), out)
    return
  }

  // version is handled in main(); other client-local flags shouldn't reach here.
  out.error(`Unknown command: ${firstArg}\n\n${printCliHelp(mode)}`)
}

async function main() {
  const rawArgv = process.argv.slice(2)
  const isTTY = Boolean(process.stdout.isTTY)

  if (rawArgv.includes('--version') || rawArgv.includes('-V')) {
    console.log(`kb v${CLIENT_VERSION}`)
    return
  }

  const globalFlags = parseGlobalCliFlags(rawArgv)
  const { args } = globalFlags
  applyConnectionOverrides(globalFlags)

  await migrateLegacyKbSessionJson()

  // Launch TUI when invoked interactively with no arguments
  if (isTTY && args.length === 0) {
    const isFreshInstall = isFreshClientInstall()
    const kbConfig = await ensureDefaultConfig()
    applyConfigToEnv(kbConfig)

    const startupNotices: string[] = []

    if (isFreshInstall) {
      startupNotices.push(FIRST_RUN_WELCOME_NOTICE)
      await markClientInitialized()
    }

    const serverHost = formatServerAddress(resolveServerConnection(kbConfig))
    // One base resolver for the wire and the UI; if none is selected locally, show
    // the base kb-server will actually serve.
    const sessionBase =
      (await resolveActiveBaseName(kbConfig)) ?? (await discoverRemoteDefaultBase(kbConfig))
    startupNotices.unshift(formatConnectionContext(kbConfig, sessionBase))
    const { launchTui } = await import('../tui/index.js')
    await launchTui(kbConfig, { startupNotices, serverHost, baseName: sessionBase })
    return
  }

  if (isHelpOnlyInvocation(args)) {
    console.log(`🤖 KB Agent Harness v${CLIENT_VERSION}\n`)
    await runMainWithOutput(args, defaultCliOutput, {} as KbConfig)
    return
  }

  const kbConfig = await ensureDefaultConfig()
  applyConfigToEnv(kbConfig)

  // Skip banner when docs generate --output json (stdout must be parseable JSON only).
  const machineJsonStdout = isDocsGenerateJsonOutputArgs(args)
  if (!machineJsonStdout) {
    console.log(`🤖 KB Agent Harness v${CLIENT_VERSION}\n`)
    const cliBase =
      (await resolveActiveBaseName(kbConfig)) ?? (await discoverRemoteDefaultBase(kbConfig))
    console.log(formatConnectionContext(kbConfig, cliBase))
    console.log('')
  }
  await runMainWithOutput(args, defaultCliOutput, kbConfig)
}

function isHelpOnlyInvocation(args: string[]): boolean {
  if (args.length === 0) return false
  return args.includes('--help') || args.includes('-h') || args[0] === 'help' || args[1] === 'help'
}

main().catch(error => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
