#!/usr/bin/env node

/**
 * KB Agent Harness CLI
 * Quick demo runner
 */

import { createKBToolsRegistry } from '../tools/kb-tools-registry'
import { readKbConfig, applyConfigToEnv, createLLMProviderFromConfig } from './kb-config'
import { runIntentLoop } from '../core/intent-loop'
import { invalidateFactTool } from '../tools/invalidate-fact-tool'
import {
  enrichReadDocumentsAnswerWithLLM,
  formatIntentResult,
  isIntentCommand,
  parseIntentCommand,
  printIntentHelp,
} from './intent-cli'
import {
  formatDefaultCommandHelp,
  formatUseCommandHelp,
  readBaseConfig,
  resolveBaseToDir,
  resolveEffectiveBaseDir,
  writeDefaultBase,
  writeSessionBase,
} from './base-selection'
import { printConfigHelp, runConfigCommand } from './config-cli'
import { parsePublishCommand, runPublishCommand } from './publish-cli'
import { parseInitCommand, runKbInit } from './init-cli'
import { runChatSession } from './chat-cli'
import {
  printListHelp,
  printViewHelp,
  runListCommand,
  runViewCommand,
  ViewCommandError,
} from './view-cli'

function printCliHelp(): string {
  return [
    'KB Agent Harness',
    '',
    'Usage:',
    '  kb <query>',
    '  kb <sessionFile.md> <query>',
    '  kb chat',
    '  kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run]',
    '  kb docs <list|view> [options]',
    '  kb init [--base <name>] [--detach | --resume] [--stop-after <cycle>]',
    '  kb config <get|set|unset> [options]',
    '  kb publish [options]',
    '  kb <intent-command> [options]',
    '',
    printIntentHelp(),
    '',
    printConfigHelp(),
    '',
    printListHelp(),
    '',
    printViewHelp(),
    '',
    'Examples:',
    '  kb "What tools are available?"',
    '  kb query "document store plan" --limit 5 --output json',
    '  kb use dogfood',
    '  kb use --show',
    '  kb default dogfood',
    '  kb default --show',
    '  kb config get',
    '  kb config get selectedBase',
    '  kb config set selectedBase dogfood',
    '  kb invalidate "We deploy to GCP" "We deploy to AWS" --apply',
    '  kb docs list --base dogfood --limit 20',
    '  kb docs view kb-base-selection-and-usage',
    '  kb docs view --title "KB Base Selection and Usage"',
    '  kb chat',
    '  kb publish --base dogfood --dry-run',
    '  kb publish --base dogfood --apply --stop-after pass2',
    '  kb publish --base dogfood --apply --resume-from .tmp/notion-publish/dogfood-latest.checkpoint.json',
    '  kb submit "Fact text" --target session-log-2026-04-12',
    '',
    'Flags:',
    '  -h, --help    Show this help message',
  ].join('\n')
}


async function main() {
  const kbConfig = await readKbConfig()
  applyConfigToEnv(kbConfig)
  console.log('🤖 KB Agent Harness\n')

  // Parse arguments: [sessionFile?] query...
  const args = process.argv.slice(2)
  const firstArg = args[0]

  // kb invalidate <old-fact> [<replacement-fact>] [--preview|--apply|--dry-run]
  if (firstArg === 'invalidate') {
    const oldFact = args[1]
    const replacementFact = args[2] && !args[2].startsWith('--') ? args[2] : undefined
    const preview = args.includes('--preview') || !args.includes('--apply')
    const dryRun = args.includes('--dry-run')

    if (!oldFact) {
      console.error('❌ Usage: kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run]')
      process.exit(1)
    }

    const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir
    const result = await invalidateFactTool(
      { oldFact, replacementFact, preview, dryRun, includeSessionLogs: true },
      kbStorageDir,
    )

    for (const change of result.changes) {
      console.log(`\nDocument: ${change.documentId} (${change.title})\nReplaced: ${change.replaced}\nDiff:\n${change.diff}`)
    }
    console.log(`\n${result.summary}`)
    if (result.error) {
      console.error(`❌ ${result.error}`)
      process.exit(1)
    }
    return
  }

  if (args.length === 0 || firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    console.log(printCliHelp())
    return
  }

  if (firstArg === 'use') {
    const base = args[1]
    if (base === '--show' || !base) {
      const configured = await readBaseConfig()
      let effective: Awaited<ReturnType<typeof resolveEffectiveBaseDir>> | null = null
      try {
        effective = await resolveEffectiveBaseDir()
      } catch {
        // No active base configured yet.
      }

      console.log('KB base configuration')
      if (effective) {
        console.log(`Source: ${effective.source}`)
        console.log(`Base: ${effective.baseName}`)
        console.log(`Resolved path: ${effective.baseDir}`)
      } else {
        console.log('No active base configured.')
      }
      if (configured.selectedBase) {
        console.log(`Selected base: ${configured.selectedBase}`)
      }
      return
    }

    await writeSessionBase(base)
    const resolved = resolveBaseToDir(base)
    console.log(formatUseCommandHelp(base, resolved))
    return
  }

  if (firstArg === 'default') {
    const base = args[1]
    if (base === '--show' || !base) {
      const configured = await readBaseConfig()
      if (!configured.selectedBase) {
        console.log('No base configured. Use: kb default <base>')
        return
      }
      const resolved = resolveBaseToDir(configured.selectedBase)
      console.log(`Selected base: ${configured.selectedBase}`)
      console.log(`Resolved path: ${resolved}`)
      console.log('Use `kb default <base>` or `kb use <base>` to change it.')
      return
    }

    const saved = await writeDefaultBase(base)
    const resolved = resolveBaseToDir(saved.selectedBase ?? base)
    console.log(formatDefaultCommandHelp(saved.selectedBase ?? base, resolved))
    return
  }

  if (firstArg === 'chat') {
    const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir
    const llmProvider = createLLMProviderFromConfig(kbConfig)

    if (!llmProvider) {
      console.error('❌ Provider setup failed: no LLM credentials found in ~/.kb/config.json or environment')
      process.exit(1)
    }

    const toolExecutor = createKBToolsRegistry(kbStorageDir, kbConfig)
    console.log(`🗂️ KB Storage: ${kbStorageDir}`)
    console.log('')
    await runChatSession({ llmProvider, toolExecutor })
    return
  }

  if (firstArg === 'config') {
    try {
      const result = await runConfigCommand(args.slice(1))
      console.log(result.output)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`❌ ${message}`)
      process.exit(1)
    }
  }

  if (firstArg === 'publish') {
    try {
      const parsed = parsePublishCommand(args.slice(1))
      const result = await runPublishCommand(parsed)
      console.log(JSON.stringify(result, null, 2))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`❌ ${message}`)
      process.exit(1)
    }
  }

  if (firstArg === 'docs') {
    const docsAction = args[1]

    if (!docsAction || docsAction === '--help' || docsAction === '-h' || docsAction === 'help') {
      console.log([
        'kb docs commands',
        '',
        'Usage:',
        '  kb docs list [options]',
        '  kb docs view <document-id> [options]',
        '',
        printListHelp(),
        '',
        printViewHelp(),
      ].join('\n'))
      return
    }

    if (docsAction === 'view') {
      try {
        const result = await runViewCommand(args.slice(2))
        process.stdout.write(result.output)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const exitCode = error instanceof ViewCommandError ? error.exitCode : 1
        if (exitCode === 0) {
          console.log(message)
          return
        }
        console.error(`❌ ${message}`)
        process.exit(exitCode)
      }
    }

    if (docsAction === 'list') {
      try {
        const result = await runListCommand(args.slice(2))
        process.stdout.write(result.output)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const exitCode = error instanceof ViewCommandError ? error.exitCode : 1
        if (exitCode === 0) {
          console.log(message)
          return
        }
        console.error(`❌ ${message}`)
        process.exit(exitCode)
      }
    }

    console.error(`❌ Unknown docs action: ${docsAction}`)
    console.error('')
    console.error([
      'kb docs commands',
      '',
      'Usage:',
      '  kb docs list [options]',
      '  kb docs view <document-id> [options]',
    ].join('\n'))
    process.exit(1)
  }

  if (firstArg === 'view') {
    console.error('❌ `kb view` has moved to `kb docs view`.')
    process.exit(1)
  }

  if (firstArg === 'list') {
    console.error('❌ `kb list` has moved to `kb docs list`.')
    process.exit(1)
  }

  if (firstArg === 'init') {
    try {
      const parsed = parseInitCommand(args.slice(1))
      const result = await runKbInit(parsed)
      console.log(JSON.stringify(result, null, 2))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`❌ ${message}`)
      process.exit(1)
    }
  }

  const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir

  if (isIntentCommand(firstArg)) {
    try {
      const parsed = parseIntentCommand(args)
      const intentBaseDir = parsed.base
        ? resolveBaseToDir(parsed.base)
        : kbStorageDir
      const toolExecutor = createKBToolsRegistry(intentBaseDir, kbConfig)
      const llmProvider = createLLMProviderFromConfig(kbConfig)
      const { result } = await runIntentLoop(parsed.envelope, toolExecutor, { provider: llmProvider })
      const enriched = await enrichReadDocumentsAnswerWithLLM(parsed, result, llmProvider)
      console.log(formatIntentResult(enriched, parsed.output))
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`❌ ${message}`)
      console.error('')
      console.error(printIntentHelp())
      process.exit(1)
    }
  }

  console.error(`❌ Unrecognized command: ${firstArg}`)
  console.error('')
  console.log(printCliHelp())
  process.exit(1)
}

main().catch(console.error)
