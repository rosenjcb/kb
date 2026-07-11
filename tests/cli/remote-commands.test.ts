import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isClientLocalCommand } from '@kb/client/cli/remote-commands.js'

describe('isClientLocalCommand', () => {
  it('[TC-27] keeps mcp/skills/uninstall/sync/base use on the client', () => {
    expect(isClientLocalCommand(['mcp', 'status'])).toBe(true)
    expect(isClientLocalCommand(['mcp', 'install', '--host', 'localhost:38117'])).toBe(true)
    expect(isClientLocalCommand(['skills', 'install'])).toBe(true)
    expect(isClientLocalCommand(['uninstall'])).toBe(true)
    expect(isClientLocalCommand(['sync'])).toBe(true)
    expect(isClientLocalCommand(['base', 'use', 'demo'])).toBe(true)
  })

  it('[TC-29] still forwards server-backed commands remotely', () => {
    expect(isClientLocalCommand(['query', 'hi'])).toBe(false)
    expect(isClientLocalCommand(['base', 'list'])).toBe(false)
    expect(isClientLocalCommand(['docs', 'list'])).toBe(false)
  })
})

describe('CLI startup wiring', () => {
  it('[TC-28] does not auto-sync MCP or install skills from main()', () => {
    const indexPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../packages/kb-client/src/cli/index.ts'
    )
    const src = readFileSync(indexPath, 'utf8')
    const mainBody = src.slice(src.indexOf('async function main()'))
    // Opt-in only: syncKbMcpConfigs / installSkillsGlobally must not run from main().
    expect(mainBody).not.toMatch(/installSkillsGlobally\s*\(/)
    expect(mainBody).not.toMatch(/syncKbMcpConfigs\s*\(/)
  })
})
