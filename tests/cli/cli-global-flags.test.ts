import { afterEach, describe, expect, it } from 'vitest'
import {
  applyConnectionOverrides,
  applyConnectionStringOverride,
  applyHostCliOverride,
  parseGlobalCliFlags,
} from '@kb/client/api/cli-global-flags.js'
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

  it('[TC-44] strips --base and --connection-string alongside remaining args', () => {
    const { args, base, connectionString, host } = parseGlobalCliFlags([
      '--base',
      'raylib',
      '--connection-string',
      'kb://localhost:38117/raylib',
      'query',
      'hi',
    ])
    expect(base).toBe('raylib')
    expect(connectionString).toBe('kb://localhost:38117/raylib')
    expect(host).toBeUndefined()
    expect(args).toEqual(['query', 'hi'])
  })

  it('[TC-45] parses --base=value and --connection-string=value inline forms', () => {
    const { base, connectionString } = parseGlobalCliFlags([
      '--base=raylib',
      '--connection-string=kb://localhost/raylib',
    ])
    expect(base).toBe('raylib')
    expect(connectionString).toBe('kb://localhost/raylib')
  })

  it('[TC-46] throws when --base has no value', () => {
    expect(() => parseGlobalCliFlags(['--base'])).toThrow('--base requires a value')
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

  it('[TC-47] expands a connection string into KB_SERVER_URL/API_KEY/BASE', () => {
    snapshot([KB_ENV.SERVER_URL, KB_ENV.SERVER_API_KEY, KB_ENV.BASE, KB_ENV.HOST, KB_ENV.PORT])
    applyConnectionStringOverride('kb://TESTKEY@kb.example.com:38117/raylib?sslmode=disable')
    expect(process.env[KB_ENV.SERVER_URL]).toBe('http://kb.example.com:38117')
    expect(process.env[KB_ENV.SERVER_API_KEY]).toBe('TESTKEY')
    expect(process.env[KB_ENV.BASE]).toBe('raylib')
    expect(process.env[KB_ENV.HOST]).toBeUndefined()
  })

  it('[TC-48] applyConnectionOverrides lets --base refine an explicit connection string', () => {
    snapshot([KB_ENV.SERVER_URL, KB_ENV.SERVER_API_KEY, KB_ENV.BASE, KB_ENV.HOST, KB_ENV.PORT])
    applyConnectionOverrides({
      args: [],
      connectionString: 'kb://localhost:38117/raylib?sslmode=disable',
      base: 'eval-raylib',
    })
    expect(process.env[KB_ENV.SERVER_URL]).toBe('http://localhost:38117')
    expect(process.env[KB_ENV.BASE]).toBe('eval-raylib')
  })
})
