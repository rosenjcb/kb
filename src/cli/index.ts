#!/usr/bin/env node

/**
 * KB Agent Harness CLI
 * Quick demo runner
 */

import { createKBToolsRegistry } from '../tools/kb-tools-registry'
import { readKbConfig, applyConfigToEnv, createLLMProviderFromConfig, resolveGraphEnabled } from './kb-config'
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
  ensureOperationalBaseDir,
  formatDefaultCommandHelp,
  formatUseCommandHelp,
  readBaseConfig,
  resolveEffectiveBaseDir,
  writeDefaultBase,
  writeSessionBase,
} from './base-selection'
import { runConfigCommand } from './config-cli'
import { parsePublishCommand, runPublishCommand } from './publish-cli'
import { parseInitCommand, runKbInit } from './init-cli'
import { DuckGraphWriter } from '../tools/duck-graph-writer'
import { extractGraph } from '../tools/graph-entity-extractor'
import { expandQueryWithGraph } from '../tools/graph-query-expansion'
import { GraphCommandError, parseGraphCommand, printGraphHelp, runGraphCommand } from './graph-cli'
import { printChatHelp, runChatSession } from './chat-cli'
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
    '  kb <intent-command> [options]',
    '  kb docs <command> [options]',
    '  kb use [<base>] [--show] [--default]',
    '  kb config <command> [options]',
    '  kb init [options]',
    '  kb graph [options]',
    '  kb publish [options]',
    '  kb chat',
    '  kb invalidate "<old-fact>" ["<replacement-fact>"] [--preview|--apply|--dry-run]',
    '',
    'Commands:',
    '  docs      Browse KB documents (`kb docs --help`)',
    '  use       Switch or inspect the active/default base (`kb use --help`)',
    '  config    Manage persistent config (`kb config --help`)',
    '  init      Build a KB from project docs (`kb init --help`)',
    '  graph     Inspect the knowledge graph (`kb graph --help`)',
    '  publish   Publish KB docs (`kb publish --help`)',
    '  chat      Start an interactive KB chat session (`kb chat --help`)',
    '  invalidate  Remove or replace stale KB facts',
    '',
    'Intent commands:',
    '  submit, validate, dispute, query, explain',
    '  Run `kb query --help` or `kb submit --help` for intent usage.',
    '',
    'Examples:',
    '  kb use dogfood',
    '  kb use --default dogfood',
    '  kb docs --help',
    '  kb query "document store plan" --limit 5 --output json',
    '  kb docs list --base dogfood --limit 20',
    '  kb docs view kb-base-selection-and-usage',
  ].join('\n')
}

function printUseHelp(): string {
  return [
    'kb use commands',
    '',
    'Usage:',
    '  kb use <base>',
    '  kb use --default <base>',
    '  kb use --show',
    '',
    'Examples:',
    '  kb use dogfood',
    '  kb use --default dogfood',
    '  kb use --show',
  ].join('\n')
}

function printDocsHelp(): string {
  return [
    'kb docs commands',
    '',
    'Usage:',
    '  kb docs list [options]',
    '  kb docs view <document-id> [options]',
    '',
    printListHelp(),
    '',
    printViewHelp(),
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

    // Soft-delete graph edges for affected documents when actually applying changes
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

    return
  }

  if (args.length === 0 || firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    console.log(printCliHelp())
    return
  }

  if (firstArg === 'use') {
    const show = args.includes('--show')
    const makeDefault = args.includes('--default')
    const help = args.includes('--help') || args.includes('-h') || args[1] === 'help'
    const base = args.find((token, index) =>
      index > 0 && !token.startsWith('--'),
    )

    if (help) {
      console.log(printUseHelp())
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
      console.log('KB base configuration')
      if (effective) {
        console.log(`Source: ${effective.source}`)
        console.log(`Base: ${effective.baseName}`)
        console.log(`Resolved path: ${effective.baseDir}`)
      } else {
        console.log('No active base configured.')
      }
      if (configured.activeBase) {
        console.log(`Session base: ${configured.activeBase}`)
      }
      if (configured.selectedBase) {
        console.log(`Default base: ${configured.selectedBase}`)
      }
      return
    }

    if (makeDefault) {
      const saved = await writeDefaultBase(base)
      const resolved = await ensureOperationalBaseDir(saved.selectedBase ?? base)
      console.log(formatDefaultCommandHelp(saved.selectedBase ?? base, resolved))
      return
    }

    await writeSessionBase(base)
    const resolved = await ensureOperationalBaseDir(base)
    console.log(formatUseCommandHelp(base, resolved))
    return
  }

  if (firstArg === 'default') {
    const base = args[1]
    if (base === '--show' || !base) {
      const configured = await readBaseConfig()
      if (!configured.selectedBase) {
        console.log('No default base configured.')
        console.log('  Set one with: kb use --default <base>')
        return
      }
      const resolved = await ensureOperationalBaseDir(configured.selectedBase)
      console.log(`Default base: ${configured.selectedBase}`)
      console.log(`Resolved path: ${resolved}`)
      if (configured.activeBase) {
        console.log(`Current session base: ${configured.activeBase}`)
      }
      console.log('Use `kb use <base>` to switch the active base without changing the saved default.')
      return
    }

    const saved = await writeDefaultBase(base)
    const resolved = await ensureOperationalBaseDir(saved.selectedBase ?? base)
    console.log(formatDefaultCommandHelp(saved.selectedBase ?? base, resolved))
    return
  }

  if (firstArg === 'chat') {
    if (args.includes('--help') || args.includes('-h') || args[1] === 'help') {
      console.log(printChatHelp())
      return
    }

    const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir
    const llmProvider = createLLMProviderFromConfig(kbConfig)

    if (!llmProvider) {
      console.error('❌ Provider setup failed: no LLM credentials found in ~/.kb/config.json or environment')
      process.exit(1)
    }

    const toolExecutor = createKBToolsRegistry(kbStorageDir, kbConfig)
    const chatGraphWriter = resolveGraphEnabled(kbConfig)
      ? new DuckGraphWriter(DuckGraphWriter.dbPathForBase(kbStorageDir))
      : undefined
    console.log(`🗂️ KB Storage: ${kbStorageDir}`)
    console.log('')
    await runChatSession({ llmProvider, toolExecutor, graphWriter: chatGraphWriter })
    return
  }

  if (firstArg === 'config') {
    try {
      const result = await runConfigCommand(args.slice(1))
      console.log(result.output)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('kb config commands')) {
        console.log(message)
        return
      }
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
      console.log(printDocsHelp())
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

  if (firstArg === 'graph') {
    try {
      const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir
      const opts = parseGraphCommand(args.slice(1))
      await runGraphCommand(kbStorageDir, opts)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof GraphCommandError && error.exitCode === 0) {
        console.log(message)
        return
      }
      console.error(`❌ ${message}`)
      if (!(error instanceof GraphCommandError)) {
        console.error('')
        console.error(printGraphHelp())
      }
      process.exit(1)
    }
  }

  if (isIntentCommand(firstArg)) {
    try {
      const kbStorageDir = (await resolveEffectiveBaseDir()).baseDir
      const parsed = parseIntentCommand(args)
      const intentBaseDir = parsed.base
        ? await ensureOperationalBaseDir(parsed.base)
        : kbStorageDir
      if (parsed.envelope.intent === 'query_truth' && resolveGraphEnabled(kbConfig)) {
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
      const toolExecutor = createKBToolsRegistry(intentBaseDir, kbConfig)
      const llmProvider = createLLMProviderFromConfig(kbConfig)
      const { result } = await runIntentLoop(parsed.envelope, toolExecutor, { provider: llmProvider })

      // Synchronous graph extraction for submit_fact
      if (
        parsed.envelope.intent === 'submit_fact' &&
        result.status === 'accepted' &&
        llmProvider &&
        resolveGraphEnabled(kbConfig)
      ) {
        const fact = String(parsed.envelope.payload.fact ?? '').trim()
        if (fact) {
          try {
            const graphWriter = new DuckGraphWriter(DuckGraphWriter.dbPathForBase(intentBaseDir))
            const { entities, relationships } = await extractGraph(fact, llmProvider)
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
