import { render } from 'ink'
import { createElement } from 'react'
import type { KbConfig } from '@kb/core/config/kb-config.js'
import { App } from './App.js'

/**
 * Launch the Ink TUI. Called from the CLI entry point when running
 * interactively with no arguments in a TTY.
 */
export async function launchTui(
  config: KbConfig,
  options: {
    startupNotices?: string[]
    serverHost?: string
    baseName?: string
    baseIsFallback?: boolean
  } = {}
): Promise<void> {
  const { waitUntilExit } = render(
    createElement(App, {
      config,
      startupNotices: options.startupNotices ?? [],
      serverHost: options.serverHost ?? 'localhost',
      initialBaseName: options.baseName,
      initialBaseIsFallback: options.baseIsFallback,
    })
  )
  await waitUntilExit()
}
