import { type CmdMode, cmd, cmdHelpHint, cmdIntro } from '@kb/core/config/cmd-ref.js'
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
    '  entities    Inspect harvested entities (services, surfaces) and name collisions',
    '  facts       List, search, or show KB facts',
    '  sync        Install the latest published KB release',
    '  logs        Browse and compare run reports',
    '  session     Show the most recent chat session and its runs',
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
    '',
    'Base creation and deletion are operator actions on the server host',
    '(`kb-server start --base <name> --git <repo>` / `kb-server base delete --base <name>`).',
  ].join('\n')
}

export { printLogsHelp }
