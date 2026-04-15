import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runConfigCommand } from '../../src/cli/config-cli'
import { readKbConfig } from '../../src/cli/kb-config'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
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

    expect(result.output).toContain('"defaultBase": "dogfood"')
    expect(result.output).toContain('"parentPageId": "abc123"')
    expect(result.output).not.toContain('sessionBase')
  })

  it('Given set defaultBase, then writes config and drops deprecated sessionBase', async () => {
    const configFile = await createConfigFile({
      sessionBase: 'legacy-session',
      notion: { token: 'secret' },
    })

    const result = await runConfigCommand(['set', 'defaultBase', 'dogfood'], { configFile })
    const saved = await readKbConfig(configFile)

    expect(result.output).toContain('Set defaultBase')
    expect(saved.defaultBase).toBe('dogfood')
    expect(saved.notion?.token).toBe('secret')
    expect(saved.sessionBase).toBeUndefined()
    expect(saved.updatedAt).toBeTruthy()
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

    await expect(runConfigCommand(['get', 'defaultBase'], { configFile })).rejects.toThrow(
      'CONFIG_VALUE_NOT_SET',
    )
  })
})
