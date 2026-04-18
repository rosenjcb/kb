export type CmdMode = 'cli' | 'tui'

export function cmd(name: string, mode: CmdMode = 'cli'): string {
  return mode === 'tui' ? `/${name}` : `kb ${name}`
}

export function cmdIntro(mode: CmdMode): string {
  return mode === 'tui'
    ? 'Type a command or intent below. Use /<command> --help for detailed usage.'
    : 'Starts the interactive TUI when run with no arguments (in a TTY).\nPass a command for one-shot CLI mode.'
}

export function cmdHelpHint(mode: CmdMode): string {
  return mode === 'tui'
    ? 'Run `/<command> --help` for detailed usage.'
    : 'Run `kb <command> --help` for detailed usage.'
}
