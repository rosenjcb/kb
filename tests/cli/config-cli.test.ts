import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { printConfigHelp, runConfigCommand } from '../../src/cli/config-cli'
import { getKbConfigFile, listSupportedConfigPaths, readKbConfig, resolveGraphEnabled } from '../../src/cli/kb-config'

const tempDirs: string[] = []
let kbHomeDir: string

beforeEach(async () => {
  kbHomeDir = await mkdtemp(path.join(os.tmpdir(), 'kb-home-'))
  process.env.KB_HOME = kbHomeDir
})

afterEach(async () => {
  delete process.env.KB_HOME
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  if (kbHomeDir) {
    await rm(kbHomeDir, { recursive: true, force: true })
  }
})

async function createConfigFile(initial?: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-config-cli-'))
  tempDirs.push(dir)
  const configFile = path.join(dir, 'config.json')
  if (initial !== undefined) {
    await writeFile(configFile, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
  }
  return configFile
}

describe('config-cli', () => {
  it('Given get with no key, then returns normalized full config JSON', async () => {
    const configFile = await createConfigFile({
      defaultBase: 'dogfood',
      sessionBase: 'old-session',
      notion: { parentPageId: 'abc123' },
      updatedAt: '2026-04-15T00:00:00.000Z',
    })

    const result = await runConfigCommand(['get'], { configFile })

    expect(result.output).toContain('"selectedBase": "old-session"')
    expect(result.output).toContain('"parentPageId": "abc123"')
    expect(result.output).not.toContain('defaultBase')
  })

  it('Given nested notion key, then get returns scalar and unset prunes empty object', async () => {
    const configFile = await createConfigFile()

    await runConfigCommand(['set', 'notion.parentPageId', 'parent-123'], { configFile })
    const value = await runConfigCommand(['get', 'notion.parentPageId'], { configFile })
    await runConfigCommand(['unset', 'notion.parentPageId'], { configFile })
    const rawAfterUnset = JSON.parse(await readFile(configFile, 'utf8')) as { notion?: unknown }

    expect(value.output).toBe('parent-123\n')
    expect(rawAfterUnset.notion).toBeUndefined()
  })

  it('Given read-only or unknown keys, then returns explicit errors', async () => {
    const configFile = await createConfigFile()

    await expect(runConfigCommand(['set', 'updatedAt', '123'], { configFile })).rejects.toThrow(
      'READ_ONLY_CONFIG_KEY',
    )
    await expect(runConfigCommand(['get', 'foo.bar'], { configFile })).rejects.toThrow(
      'UNKNOWN_CONFIG_KEY',
    )
  })

  it('Given supported but unset key, then get returns explicit not-set error', async () => {
    const configFile = await createConfigFile({})

    await expect(runConfigCommand(['get', 'selectedBase'], { configFile })).rejects.toThrow(
      'UNKNOWN_CONFIG_KEY',
    )
  })

  it('Given KB_HOME override and no explicit config file, then config commands use the overridden home config path', async () => {
    await runConfigCommand(['set', 'notion.parentPageId', 'catalog-root'])

    const saved = await readKbConfig(getKbConfigFile())

    expect(saved.notion?.parentPageId).toBe('catalog-root')
    expect(getKbConfigFile()).toBe(path.join(kbHomeDir, 'config.json'))
  })

  it('Given config help, then it excludes base keys and generated feature keys', () => {
    const help = printConfigHelp()
    expect(help).not.toContain('selectedBase')
    expect(help).not.toContain('defaultBase')
    expect(help).not.toContain('features.')
    expect(help).toContain('graph.enabled')
    expect(help).toContain('notion.parentPageId')
    expect(help).toContain('llm.openaiApiKey')
  })

  it('Given supported config paths, then they omit base-selection and feature keys', () => {
    const keys = listSupportedConfigPaths()
    expect(keys).not.toContain('selectedBase')
    expect(keys).not.toContain('defaultBase')
    expect(keys).not.toContain('features')
    expect(keys).toContain('graph')
    expect(keys).toContain('graph.enabled')
    expect(keys).toContain('notion')
    expect(keys).toContain('llm')
  })

  it('Given graph.enabled key, then config set/get/unset round-trips the boolean flag', async () => {
    const configFile = await createConfigFile()

    await runConfigCommand(['set', 'graph.enabled', 'false'], { configFile })
    const value = await runConfigCommand(['get', 'graph.enabled'], { configFile })
    await runConfigCommand(['unset', 'graph.enabled'], { configFile })
    const saved = await readKbConfig(configFile)

    expect(value.output).toBe('false\n')
    expect(saved.graph).toBeUndefined()
  })

  it('Given KB_GRAPH env override, then it wins over config graph.enabled', () => {
    process.env.KB_GRAPH = 'false'

    expect(resolveGraphEnabled({ graph: { enabled: true } })).toBe(false)

    delete process.env.KB_GRAPH
  })
})
