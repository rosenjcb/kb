import { afterEach, describe, expect, it } from 'vitest'
import {
  applyApiKeyCliOverride,
  applyConnectionOverrides,
  applyConnectionStringOverride,
  applyHostCliOverride,
  applyPortCliOverride,
  applySslModeCliOverride,
  parseGlobalCliFlags,
} from '@kb/client/api/cli-global-flags.js'
import { KB_ENV } from '@kb/core/config/kb-env.js'

describe('parseGlobalCliFlags', () => {
  it('[TC-6] strips --host and returns remaining args', () => {
    const { args, host } = parseGlobalCliFlags(['--host', 'localhost:38117', 'query', 'hi'])
    expect(host).toBe('localhost:38117')
    expect(args).toEqual(['query', 'hi'])
  })

  it('[TC-7] parses --host=value form', () => {
    const { args, host } = parseGlobalCliFlags(['--host=remote:9999', 'base', 'list'])
    expect(host).toBe('remote:9999')
    expect(args).toEqual(['base', 'list'])
  })

  it('[TC-8] throws when --host has no value', () => {
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

  it('[TC-56] strips --port, --sslmode, --api-key, and the --key alias', () => {
    const { args, port, sslmode, apiKey } = parseGlobalCliFlags([
      '--port',
      '9443',
      '--sslmode',
      'require',
      '--api-key',
      'secret',
      'query',
      'hi',
    ])
    expect(port).toBe('9443')
    expect(sslmode).toBe('require')
    expect(apiKey).toBe('secret')
    expect(args).toEqual(['query', 'hi'])

    const { apiKey: viaKeyAlias } = parseGlobalCliFlags(['--key=secret2'])
    expect(viaKeyAlias).toBe('secret2')
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

  it('[TC-9] sets KB_HOST and KB_PORT for host:port', () => {
    snapshot([KB_ENV.HOST, KB_ENV.PORT, KB_ENV.SSLMODE])
    applyHostCliOverride('myhost:12345')
    expect(process.env[KB_ENV.HOST]).toBe('myhost')
    expect(process.env[KB_ENV.PORT]).toBe('12345')
    expect(process.env[KB_ENV.SSLMODE]).toBeUndefined()
  })

  it('[TC-10] decomposes a full URL into KB_HOST/KB_PORT/KB_SSLMODE', () => {
    snapshot([KB_ENV.HOST, KB_ENV.PORT, KB_ENV.SSLMODE])
    applyHostCliOverride('http://remote:38117/')
    expect(process.env[KB_ENV.HOST]).toBe('remote')
    expect(process.env[KB_ENV.PORT]).toBe('38117')
    expect(process.env[KB_ENV.SSLMODE]).toBe('disable')
  })

  it('[TC-57] an explicit https:// scheme forces sslmode=require', () => {
    snapshot([KB_ENV.HOST, KB_ENV.PORT, KB_ENV.SSLMODE])
    applyHostCliOverride('https://remote:9443')
    expect(process.env[KB_ENV.HOST]).toBe('remote')
    expect(process.env[KB_ENV.PORT]).toBe('9443')
    expect(process.env[KB_ENV.SSLMODE]).toBe('require')
  })

  it('[TC-47] expands a connection string into KB_HOST/KB_PORT/KB_SSLMODE/API_KEY/BASE', () => {
    snapshot([KB_ENV.HOST, KB_ENV.PORT, KB_ENV.SSLMODE, KB_ENV.SERVER_API_KEY, KB_ENV.BASE])
    applyConnectionStringOverride('kb://TESTKEY@kb.example.com:38117/raylib?sslmode=disable')
    expect(process.env[KB_ENV.HOST]).toBe('kb.example.com')
    expect(process.env[KB_ENV.PORT]).toBe('38117')
    expect(process.env[KB_ENV.SSLMODE]).toBe('disable')
    expect(process.env[KB_ENV.SERVER_API_KEY]).toBe('TESTKEY')
    expect(process.env[KB_ENV.BASE]).toBe('raylib')
  })

  it('[TC-48] applyConnectionOverrides lets --base refine an explicit connection string', () => {
    snapshot([KB_ENV.HOST, KB_ENV.PORT, KB_ENV.SSLMODE, KB_ENV.SERVER_API_KEY, KB_ENV.BASE])
    applyConnectionOverrides({
      args: [],
      connectionString: 'kb://localhost:38117/raylib?sslmode=disable',
      base: 'eval-raylib',
    })
    expect(process.env[KB_ENV.HOST]).toBe('localhost')
    expect(process.env[KB_ENV.BASE]).toBe('eval-raylib')
  })

  it('[TC-58] applyPortCliOverride / applySslModeCliOverride / applyApiKeyCliOverride set their env vars', () => {
    snapshot([KB_ENV.PORT, KB_ENV.SSLMODE, KB_ENV.SERVER_API_KEY])
    applyPortCliOverride('9000')
    applySslModeCliOverride('REQUIRE')
    applyApiKeyCliOverride('secret')
    expect(process.env[KB_ENV.PORT]).toBe('9000')
    expect(process.env[KB_ENV.SSLMODE]).toBe('require')
    expect(process.env[KB_ENV.SERVER_API_KEY]).toBe('secret')
  })

  it('[TC-59] applySslModeCliOverride throws on an unknown mode', () => {
    expect(() => applySslModeCliOverride('bogus')).toThrow('Invalid --sslmode value')
  })

  it('[TC-60] applyConnectionOverrides applies --port/--sslmode/--api-key after --host', () => {
    snapshot([KB_ENV.HOST, KB_ENV.PORT, KB_ENV.SSLMODE, KB_ENV.SERVER_API_KEY])
    applyConnectionOverrides({
      args: [],
      host: 'remote:38117',
      port: '9999',
      sslmode: 'require',
      apiKey: 'secret',
    })
    expect(process.env[KB_ENV.HOST]).toBe('remote')
    expect(process.env[KB_ENV.PORT]).toBe('9999')
    expect(process.env[KB_ENV.SSLMODE]).toBe('require')
    expect(process.env[KB_ENV.SERVER_API_KEY]).toBe('secret')
  })
})
