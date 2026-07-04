import { describe, expect, it } from 'vitest'
import {
  booleanEnvString,
  isEnvFalse,
  isEnvTrue,
  parseBooleanConfigValue,
  parseBooleanEnv,
} from '@kb/core/config/env-boolean.js'

describe('env-boolean', () => {
  it('[TC-1] isEnvTrue accepts true only (case-insensitive)', () => {
    expect(isEnvTrue('true')).toBe(true)
    expect(isEnvTrue('TRUE')).toBe(true)
    expect(isEnvTrue('  true  ')).toBe(true)
    expect(isEnvTrue('1')).toBe(false)
    expect(isEnvTrue('false')).toBe(false)
    expect(isEnvTrue(undefined)).toBe(false)
  })

  it('[TC-2] parseBooleanConfigValue rejects numeric aliases', () => {
    expect(parseBooleanConfigValue('features.sqliteIndex', 'true')).toBe(true)
    expect(parseBooleanConfigValue('features.sqliteIndex', 'false')).toBe(false)
    expect(() => parseBooleanConfigValue('features.sqliteIndex', '1')).toThrow(/true or false/)
  })

  it('[TC-3] parseBooleanEnv falls back on unknown values', () => {
    expect(parseBooleanEnv(undefined, false)).toBe(false)
    expect(parseBooleanEnv('true', false)).toBe(true)
    expect(parseBooleanEnv('1', true)).toBe(true)
    expect(parseBooleanEnv('1', false)).toBe(false)
  })

  it('[TC-4] booleanEnvString writes lowercase literals', () => {
    expect(booleanEnvString(true)).toBe('true')
    expect(booleanEnvString(false)).toBe('false')
  })

  it('[TC-5] isEnvFalse recognizes false only', () => {
    expect(isEnvFalse('false')).toBe(true)
    expect(isEnvFalse('0')).toBe(false)
  })
})
