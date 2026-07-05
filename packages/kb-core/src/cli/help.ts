import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from '@kb/core/config/cmd-ref.js'
import { printDocsDeleteHelp } from '@kb/core/cli/docs-delete-cli.js'
import { printDocsGenerateHelp } from '@kb/core/cli/docs-generate-cli.js'
import { printDocsRenameHelp } from '@kb/core/cli/docs-rename-cli.js'
import { printListHelp, printViewHelp } from '@kb/core/cli/view-cli.js'
import { printLogsHelp } from '@kb/core/cli/logs-cli.js'

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
    '  init        Build a KB from one or more git remotes',
    '  scan        Refresh a KB by re-indexing its tracked git repos',
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
  ].join('\n')
}

export function printInitHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('init', mode)} command`,
    '',
    'Usage:',
    `  ${cmd('init --git <url> [--git <url2#branch> …] [--base <name>] [--branch <default>]', mode)}`,
    '',
    'Flags:',
    '  --git <url[#branch]>            Git remote to index (REQUIRED; repeatable)',
    '  --base <name>                  Base name (defaults to the first repo)',
    '  --non-interactive              Skip interview prompts when possible',
  ].join('\n')
}

export function printScanHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('scan', mode)} command`,
    '',
    'Usage:',
    `  ${cmd('scan', mode)} [--base <name>]`,
  ].join('\n')
}

export function printBaseHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('base', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('base list', mode)}`,
    `  ${cmd('base delete <base> [--force]', mode)}`,
    `  ${cmd('base repo list|add|remove', mode)}`,
    `  ${cmd('base ignore list|add|remove|set|clear', mode)}`,
  ].join('\n')
}

export function printBaseDeleteHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('base delete <base>', mode)}`,
    '',
    'Flags:',
    '  --force, -f   Skip confirmation',
  ].join('\n')
}

export function printDocsHelp(mode: CmdMode = 'cli'): string {
  return [
    `${cmd('docs', mode)} commands`,
    '',
    'Usage:',
    `  ${cmd('docs list', mode)}`,
    `  ${cmd('docs view <document-id>', mode)}`,
    `  ${cmd('docs generate "<prompt>"', mode)}`,
    `  ${cmd('docs rename <documentId> "<new title>"', mode)}`,
    `  ${cmd('docs delete <documentId>', mode)}`,
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

export { printLogsHelp }
