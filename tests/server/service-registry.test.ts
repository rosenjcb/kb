import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KbService } from '@kb/core/service/kb-service.js'

// Avoid the heavy provider/tool-registry init — lazy services are opaque here.
vi.mock('@kb/core/service/kb-service.js', () => ({
  createKbService: vi.fn((options: { baseDir: string }) => ({
    baseDir: options.baseDir,
    health: () => ({ ok: true, base: path.basename(options.baseDir) }),
    close: vi.fn(async () => {}),
  })),
}))

import { createKbService } from '@kb/core/service/kb-service.js'
import {
  BaseNotFoundError,
  createKbServiceRegistry,
} from '@kb/server/service-registry.js'

function fakeDefault(baseDir: string): KbService {
  return {
    baseDir,
    health: () => ({ ok: true, base: path.basename(baseDir) }),
    close: async () => {},
  } as unknown as KbService
}

let home: string
let prevHome: string | undefined

beforeEach(async () => {
  prevHome = process.env.KB_HOME
  home = await mkdtemp(path.join(os.tmpdir(), 'kb-registry-'))
  process.env.KB_HOME = home
  vi.mocked(createKbService).mockClear()
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.KB_HOME
  else process.env.KB_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

async function makeBase(slug: string): Promise<string> {
  const dir = path.join(home, 'sessions', slug)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, '.kb-index.sqlite'), 'x')
  return dir
}

describe('createKbServiceRegistry', () => {
  it('[TC-SHF7] resolves the default base for empty/matching slugs without building', async () => {
    const defaultDir = await makeBase('demo')
    const registry = createKbServiceRegistry({
      defaultService: fakeDefault(defaultDir),
      config: {},
    })
    expect(registry.defaultBaseName).toBe('demo')
    expect(registry.resolve().baseDir).toBe(defaultDir)
    expect(registry.resolve('demo').baseDir).toBe(defaultDir)
    expect(createKbService).not.toHaveBeenCalled()
  })

  it('[TC-VOAQ] lazily creates and caches a service for another built base', async () => {
    const defaultDir = await makeBase('demo')
    const raylibDir = await makeBase('raylib')
    const registry = createKbServiceRegistry({
      defaultService: fakeDefault(defaultDir),
      config: {},
    })
    const first = registry.resolve('raylib')
    const second = registry.resolve('raylib')
    expect(first.baseDir).toBe(raylibDir)
    expect(first).toBe(second)
    expect(createKbService).toHaveBeenCalledTimes(1)
  })

  it('[TC-K2XB] throws BaseNotFoundError for a base with no index', async () => {
    const defaultDir = await makeBase('demo')
    const registry = createKbServiceRegistry({
      defaultService: fakeDefault(defaultDir),
      config: {},
    })
    expect(() => registry.resolve('missing')).toThrow(BaseNotFoundError)
  })

  it('[TC-BNWZ] list() advertises the default plus every built base', async () => {
    const defaultDir = await makeBase('demo')
    await makeBase('raylib')
    const registry = createKbServiceRegistry({
      defaultService: fakeDefault(defaultDir),
      config: {},
    })
    const bases = await registry.list()
    const names = bases.map(b => b.name).sort()
    expect(names).toEqual(['demo', 'raylib'])
    expect(bases.find(b => b.name === 'demo')?.default).toBe(true)
  })
})
