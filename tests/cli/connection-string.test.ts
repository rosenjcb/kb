import { describe, expect, it } from 'vitest'
import { parseKbConnectionString } from '@kb/client/api/connection-string.js'

describe('parseKbConnectionString', () => {
  it('[TC-34] parses host + base with the default (prefer) sslmode for loopback', () => {
    const parsed = parseKbConnectionString('kb://localhost:38117/raylib')
    expect(parsed).toEqual({
      url: 'http://localhost:38117',
      hostname: 'localhost',
      port: '38117',
      sslmode: 'prefer',
      base: 'raylib',
    })
  })

  it('[TC-35] defaults a remote host to https under prefer', () => {
    const parsed = parseKbConnectionString('kb://kb.example.com/raylib')
    expect(parsed).toEqual({
      url: 'https://kb.example.com',
      hostname: 'kb.example.com',
      sslmode: 'prefer',
      base: 'raylib',
    })
  })

  it('[TC-36] reads the api key from the userinfo slot', () => {
    const parsed = parseKbConnectionString('kb://TESTKEY@kb.example.com:38117/raylib')
    expect(parsed).toEqual({
      url: 'https://kb.example.com:38117',
      hostname: 'kb.example.com',
      port: '38117',
      sslmode: 'prefer',
      apiKey: 'TESTKEY',
      base: 'raylib',
    })
  })

  it('[TC-37] takes the password slot as the api key when both are present', () => {
    const parsed = parseKbConnectionString('kb://user:SECRET@kb.example.com/raylib')
    expect(parsed.apiKey).toBe('SECRET')
  })

  it('[TC-38] sslmode=disable forces http even for a remote host', () => {
    const parsed = parseKbConnectionString('kb://kb.example.com:38117/eval-raylib?sslmode=disable')
    expect(parsed.url).toBe('http://kb.example.com:38117')
  })

  it('[TC-39] sslmode=require forces https for loopback', () => {
    const parsed = parseKbConnectionString('kb://localhost:38117/raylib?sslmode=require')
    expect(parsed.url).toBe('https://localhost:38117')
  })

  it('[TC-40] omits base when the path is empty', () => {
    const parsed = parseKbConnectionString('kb://localhost:38117')
    expect(parsed).toEqual({
      url: 'http://localhost:38117',
      hostname: 'localhost',
      port: '38117',
      sslmode: 'prefer',
    })
  })

  it('[TC-41] defaults a bare plaintext remote host to the KB server port', () => {
    const parsed = parseKbConnectionString('kb://kb.example.com/raylib?sslmode=disable')
    expect(parsed.url).toBe('http://kb.example.com:38117')
  })

  it('[TC-42] rejects a non-kb scheme', () => {
    expect(() => parseKbConnectionString('http://localhost/raylib')).toThrow(/kb:\/\//)
  })

  it('[TC-68] accepts a schemeless host:port/base as kb:// shorthand', () => {
    const parsed = parseKbConnectionString('localhost:38117/raylib')
    expect(parsed).toEqual({
      url: 'http://localhost:38117',
      hostname: 'localhost',
      port: '38117',
      sslmode: 'prefer',
      base: 'raylib',
    })
  })

  it('[TC-43] rejects an unknown sslmode', () => {
    expect(() => parseKbConnectionString('kb://localhost/raylib?sslmode=bogus')).toThrow(/sslmode/)
  })
})
