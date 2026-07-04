export type DiagnosticLevel = 'warn' | 'error' | 'info'

function diagnosticsEnabled(): boolean {
  const raw = process.env.KB_DEBUG_DIAGNOSTICS?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export function emitDiagnostic(level: DiagnosticLevel, message: string): void {
  if (!diagnosticsEnabled()) return

  if (level === 'error') {
    console.error(message)
    return
  }

  if (level === 'warn') {
    console.warn(message)
    return
  }

  console.log(message)
}
