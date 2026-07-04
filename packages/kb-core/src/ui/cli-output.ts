/** Terminal output sink shared by CLI, TUI, and server chat streaming. */
export interface CliOutput {
  log(message: string): void
  error(message: string): void
  write(chunk: string): void
  /**
   * Optional transient progress sink (e.g. streaming reasoning tokens). Unlike `log`,
   * lines sent here replace one another and disappear when passed `null`.
   */
  progress?(line: string | null): void
}
