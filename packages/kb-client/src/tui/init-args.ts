export function ensureScanBaseArg(extraArgs: string[], fallbackBaseName?: string): string[] {
  if (extraArgs.includes('--base')) return extraArgs

  const base = fallbackBaseName?.trim()
  if (!base) return extraArgs

  return [...extraArgs, '--base', base]
}
