/**
 * Boolean environment variables — only the strings `true` and `false` (case-insensitive).
 * Do not use `1`, `0`, `yes`, `on`, etc.
 */

export function isEnvTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

export function isEnvFalse(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'false'
}

/** Read an optional env flag; unknown values fall back to `fallback`. */
export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return fallback
}

/** Parse boolean env/config values — rejects non true/false strings. */
export function parseBooleanConfigValue(keyPath: string, value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`${keyPath} must be true or false`)
}

/** Write a boolean to an env var as lowercase `true` / `false`. */
export function booleanEnvString(value: boolean): string {
  return value ? 'true' : 'false'
}
