#!/usr/bin/env node

/**
 * KB Agent Harness CLI — thin client. Always talks HTTP to a kb-server host.
 */

import chalk from 'chalk'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { CLIENT_VERSION } from '../version.js'
import {
  DEFAULT_BASE_SLUG,
  ensureOperationalBaseDir,
  formatUseCommandHelp,
  readBaseConfig,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  writeSessionBase,
} from '@kb/core/storage/base-selection.js'
import { uninitializedBaseNotice } from '@kb/core/config/cli-prerequisites.js'
import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from '@kb/core/config/cmd-ref.js'
import { cliHelpCommands } from '@kb/core/commands/command-catalog.js'
import {
  applyConfigToEnv,
  isFreshClientInstall,
  markClientInitialized,
  readKbConfig,
} from '@kb/core/config/kb-config.js'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import {
  formatSkillInstallReport,
  formatSkillUninstallReport,
  formatSkillsStatusReport,
  installHooks,
  installMcpConfigs,
  installSkillIntoProject,
  installSkillsGlobally,
  readSkillsStatus,
  uninstallHooks,
  uninstallMcpConfigs,
  uninstallSkills,
} from './skill-installer'
import { printSyncHelp, runSyncCommand } from './sync-cli'
import {
  resolveDisplayBase,
  isClientLocalCommand,
  runRemoteCliCommand,
} from './remote-commands.js'
import {
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
  '  kb facts       list, search, or show KB facts',
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
    '  --base <slug>              server-side base to use (sent as X-KB-Base; else KB_BASE, else "default")',
    '  --connection-string <uri>  kb://[apikey@]host[:port]/[base][?sslmode=] (else KB_CONNECTION_STRING)',
    '',
    'Core commands:',
    ...formatCommandList(false),
    '',
    'Intent commands:',
    ...formatCommandList(true),
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
    `  ${cmd('facts list --base dogfood', mode)}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

/**
 * Render the `kb --help` command list (Core or Intent) straight from the shared
 * command catalog, so a command added to the catalog shows up in help automatically.
 */
function formatCommandList(intent: boolean): string[] {
  const commands = cliHelpCommands().filter(c => c.intent === intent)
  const width = Math.max(...commands.map(c => c.name.length)) + 2
  return commands.map(c => `  ${c.name.padEnd(width)}${c.summary}`)
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
    `  ${cmd('base use --show', mode)}               Show current base configuration`,
    '',
    'With no active base selected you are on this client\'s own fallback base, "default"',
    '(shown as "(no active base selected)"); `base use <base>` switches to a named base.',
    '',
    'Bases are created and deleted on the server (operator actions): a base is built by',
    '`kb-server base create --base <name> --git <repo>` and removed by',
    '`kb-server base delete --base <name>`. The repos a base indexes and the paths it skips',
    'are declared on the server — see packages/kb-server/README.md.',
    '',
    'Examples:',
    `  ${cmd('base', mode)}`,
    `  ${cmd('base use dogfood', mode)}`,
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

  // Forward server-owned commands (query, docs, facts, graph, logs, base list, …).
  if (!isClientLocalCommand(args)) {
    const code = await runRemoteCliCommand(args, out, config, mode)
    if (code && mode === 'cli') process.exitCode = code
    return
  }

  if (firstArg === 'base') {
    const subArgs = args.slice(1)
    const subCmd = subArgs[0]

    // Only `base use` (and `base delete`, which we refuse) are client-local; `base list`
    // was already forwarded above.
    if (subCmd === '--help' || subCmd === '-h' || subCmd === 'help') {
      out.log(printBaseHelp(mode))
      return
    }

    if (subCmd === 'delete') {
      out.error(
        'Deleting a base is an operator action on the server, not a client command. ' +
          'Run `kb-server base delete --base <base>` on the server host (or `kb-server uninstall --purge` ' +
          'to remove all server data). The client can only switch bases: `kb base use <base>`.'
      )
      if (mode === 'cli') process.exitCode = 1
      return
    }

    if (subCmd === 'use') {
      const useArgs = subArgs.slice(1)
      const show = useArgs.includes('--show')
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
          // No local active base — this client falls back to the reserved `default`
          // slug, the same hardcoded constant kb-server always materializes. No
          // server probe needed; the client already knows its own base.
          out.log('Source: default (no active base selected)')
          out.log(`Base: ${DEFAULT_BASE_SLUG}`)
          out.log(`Run \`${cmd('base use <base>', mode)}\` to switch to a named base.`)
        }
        if (configured.activeBase) {
          out.log(`Active base: ${configured.activeBase}`)
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
    } else if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
      out.log(
        [
          'Usage: kb skills [subcommand]',
          '',
          'Manage the bundled KB agent skills for Claude, Cursor, Codex, and Copilot.',
          '',
          'Subcommands:',
          '  (none)      Show install status of each agent skill',
          '  install     Install skill files, profile readmes, kb-first hook,',
          '              and MCP configs for the active connection (localhost default)',
          '  uninstall   Remove skill files, readme entries, hook, and MCP entries',
          '',
          'Override the MCP host with: kb --host <host|url> skills install',
          '                        or: kb mcp install --host <host|url>',
        ].join('\n')
      )
    } else if (!subcommand) {
      // Bare `kb skills` → show whether each agent's skill is installed.
      try {
        out.log(formatSkillsStatusReport(await readSkillsStatus()))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        out.error(`❌ ${message}`)
        if (mode === 'cli') process.exitCode = 1
      }
    } else {
      out.error(`Unknown skills subcommand: ${subcommand}\n\nRun \`${cmd('skills help', mode)}\`.`)
      if (mode === 'cli') process.exitCode = 1
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

  // Launch TUI when invoked interactively with no arguments
  if (isTTY && args.length === 0) {
    const isFreshInstall = isFreshClientInstall()
    const kbConfig = await readKbConfig()
    applyConfigToEnv(kbConfig)

    const startupNotices: string[] = []

    if (isFreshInstall) {
      startupNotices.push(FIRST_RUN_WELCOME_NOTICE)
      await markClientInitialized()
    }

    const serverHost = formatServerAddress(resolveServerConnection(kbConfig))
    // One base resolver for the wire and the UI, resolved locally (no server probe);
    // if none is selected locally, show the client's own unconfigured-fallback base,
    // labeled as such.
    const display = await resolveDisplayBase(kbConfig)
    startupNotices.unshift(
      formatConnectionContext(kbConfig, display.name, { isFallback: display.isFallback })
    )
    const { launchTui } = await import('../tui/index.js')
    await launchTui(kbConfig, {
      startupNotices,
      serverHost,
      baseName: display.name,
      baseIsFallback: display.isFallback,
    })
    return
  }

  if (isHelpOnlyInvocation(args)) {
    console.log(`🤖 KB Agent Harness v${CLIENT_VERSION}\n`)
    await runMainWithOutput(args, defaultCliOutput, {} as KbConfig)
    return
  }

  const kbConfig = await readKbConfig()
  applyConfigToEnv(kbConfig)

  console.log(`🤖 KB Agent Harness v${CLIENT_VERSION}\n`)
  const display = await resolveDisplayBase(kbConfig)
  console.log(formatConnectionContext(kbConfig, display.name, { isFallback: display.isFallback }))
  console.log('')
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
