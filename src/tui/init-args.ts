export function ensureInitBaseArg(extraArgs: string[], fallbackBaseName?: string): string[] {
  const hasBase = extraArgs.includes('--base')
  if (hasBase) return extraArgs
  if (!extraArgs.includes('--rescan')) return extraArgs

  const base = fallbackBaseName?.trim()
  if (!base) return extraArgs

  return [...extraArgs, '--base', base]
}

export function ensureScanBaseArg(extraArgs: string[], fallbackBaseName?: string): string[] {
  if (extraArgs.includes('--base')) return extraArgs

  const base = fallbackBaseName?.trim()
  if (!base) return extraArgs

  return [...extraArgs, '--base', base]
}
