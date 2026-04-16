import { render } from 'ink'
import { createElement } from 'react'
import type { KbConfig } from '../cli/kb-config.js'
import { App } from './App.js'

/**
 * Launch the Ink TUI. Called from the CLI entry point when running
 * interactively with no arguments in a TTY.
 */
export async function launchTui(config: KbConfig): Promise<void> {
  const { waitUntilExit } = render(createElement(App, { config }))
  await waitUntilExit()
}
