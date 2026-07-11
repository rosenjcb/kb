import { afterEach, describe, expect, it } from 'vitest'
import { applyHostCliOverride, parseGlobalCliFlags } from '@kb/client/api/cli-global-flags.js'
import { KB_ENV } from '@kb/core/config/kb-env.js'

describe('parseGlobalCliFlags', () => {
  it('[TC-5] strips --host and returns remaining args', () => {
    const { args, host } = parseGlobalCliFlags(['--host', 'localhost:38117', 'query', 'hi'])
    expect(host).toBe('localhost:38117')
    expect(args).toEqual(['query', 'hi'])
  })

  it('[TC-6] parses --host=value form', () => {
    const { args, host } = parseGlobalCliFlags(['--host=remote:9999', 'base', 'list'])
    expect(host).toBe('remote:9999')
    expect(args).toEqual(['base', 'list'])
  })

  it('[TC-7] throws when --host has no value', () => {
    expect(() => parseGlobalCliFlags(['--host'])).toThrow('--host requires a value')
  })
})

describe('applyHostCliOverride', () => {
  const saved: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  function snapshot(keys: string[]) {
    for (const key of keys) saved[key] = process.env[key]
  }

  it('[TC-8] sets KB_HOST and KB_PORT for host:port', () => {
    snapshot([KB_ENV.HOST, KB_ENV.PORT, KB_ENV.SERVER_URL, 'KBHOST', 'KBPORT'])
    applyHostCliOverride('myhost:12345')
    expect(process.env[KB_ENV.HOST]).toBe('myhost')
    expect(process.env[KB_ENV.PORT]).toBe('12345')
    expect(process.env[KB_ENV.SERVER_URL]).toBeUndefined()
  })

  it('[TC-9] sets KB_SERVER_URL for full URL', () => {
    snapshot([KB_ENV.HOST, KB_ENV.PORT, KB_ENV.SERVER_URL, 'KBHOST', 'KBPORT'])
    applyHostCliOverride('http://remote:38117/')
    expect(process.env[KB_ENV.SERVER_URL]).toBe('http://remote:38117')
    expect(process.env[KB_ENV.HOST]).toBeUndefined()
  })
})
