import { isEnvTrue } from '../config/env-boolean.js'

export type DiagnosticLevel = 'warn' | 'error' | 'info'

function diagnosticsEnabled(): boolean {
  return isEnvTrue(process.env.KB_DEBUG_DIAGNOSTICS)
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
