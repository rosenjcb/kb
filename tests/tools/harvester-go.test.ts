import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  goModuleAliases,
  harvestGo,
  parseGoMod,
  parseGoWorkUses,
} from '@kb/core/tools/harvesters/index.js'

let scanDir: string

beforeEach(async () => {
  scanDir = await mkdtemp(path.join(os.tmpdir(), 'kb-harvest-go-'))
})

afterEach(async () => {
  await rm(scanDir, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(scanDir, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content)
}

describe('parseGoMod', () => {
  it('reads the module path and both require forms, ignoring tool directives', () => {
    const { modulePath, requires } = parseGoMod(
      [
        'module github.com/acme/widget-api/v3',
        'go 1.24',
        '',
        'require (',
        '\tgithub.com/gin-gonic/gin v1.10.0',
        '\tgithub.com/acme/shared v1.0.0 // indirect',
        ')',
        '',
        'require github.com/spf13/cobra v1.8.0',
        '',
        'tool golang.org/x/tools/cmd/stringer',
        'exclude github.com/broken/pkg v1.0.0',
      ].join('\n')
    )
    expect(modulePath).toBe('github.com/acme/widget-api/v3')
    expect(requires).toContain('github.com/gin-gonic/gin')
    expect(requires).toContain('github.com/acme/shared')
    expect(requires).toContain('github.com/spf13/cobra')
    // Go 1.24 `tool` pins are build-time deps — they must not reach framework detection.
    expect(requires).not.toContain('golang.org/x/tools/cmd/stringer')
    expect(requires).not.toContain('github.com/broken/pkg')
  })
})

describe('goModuleAliases', () => {
  it('emits the unsuffixed path so /v3 and the bare module are one thing', () => {
    expect(goModuleAliases('github.com/acme/widget-api/v3', 'widget-api')).toEqual(
      expect.arrayContaining(['github.com/acme/widget-api', 'widget-api'])
    )
    expect(goModuleAliases('github.com/acme/widget-api', 'widget-api')).toContain('widget-api')
  })
})

describe('parseGoWorkUses', () => {
  it('handles block and single-line use directives', () => {
    expect(parseGoWorkUses('go 1.24\n\nuse (\n\t./svc-a\n\t./libs/b\n)\n')).toEqual([
      './svc-a',
      './libs/b',
    ])
    expect(parseGoWorkUses('go 1.24\n\nuse ./only\n')).toEqual(['./only'])
  })
})

describe('harvestGo', () => {
  it('enumerates cmd/<name> binaries and classifies them from module frameworks', async () => {
    await write(
      'go.mod',
      'module github.com/acme/platform\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n'
    )
    await write('cmd/api/main.go', 'package main\n\nfunc main() {}\n')
    await write('cmd/worker/main.go', 'package main\n\nfunc main() {}\n')

    const { candidates, edges } = await harvestGo(scanDir)
    const byName = new Map(candidates.map(c => [c.canonicalName, c]))

    expect(byName.get('github.com/acme/platform')?.kind).toBe('module')
    const api = byName.get('github.com/acme/platform/cmd/api')
    expect(api?.kind).toBe('service')
    // The bare binary name is what operators type — it must be an alias.
    expect(api?.aliases).toContain('api')
    expect(byName.get('github.com/acme/platform/cmd/worker')).toBeDefined()
    expect(edges).toContainEqual({
      fromName: 'github.com/acme/platform/cmd/api',
      toName: 'github.com/acme/platform',
      edgeType: 'part_of',
    })
  })

  it('classifies cmd binaries as cli when a CLI framework is required', async () => {
    await write('go.mod', 'module github.com/acme/tool\n\nrequire github.com/spf13/cobra v1.8.0\n')
    await write('cmd/acmectl/main.go', 'package main\n')

    const { candidates } = await harvestGo(scanDir)
    const bin = candidates.find(c => c.canonicalName.endsWith('/cmd/acmectl'))
    expect(bin?.kind).toBe('cli')
    expect(bin?.aliases).toContain('acmectl')
  })

  it('treats a module with no binaries as a library', async () => {
    await write('go.mod', 'module github.com/acme/shared\n')
    await write('shared.go', 'package shared\n')

    const { candidates } = await harvestGo(scanDir)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.kind).toBe('library')
  })

  it('discovers nested modules and skips testdata fixtures', async () => {
    await write('go.mod', 'module github.com/acme/root\n')
    await write('services/billing/go.mod', 'module github.com/acme/billing\n')
    await write('testdata/fixture/go.mod', 'module example.com/fixture\n')

    const { candidates } = await harvestGo(scanDir)
    const names = candidates.map(c => c.canonicalName).sort()
    expect(names).toContain('github.com/acme/root')
    expect(names).toContain('github.com/acme/billing')
    // golang/go#27852: testdata go.mod files are fixtures, not real modules.
    expect(names).not.toContain('example.com/fixture')
  })

  it('links go.work members to the workspace root', async () => {
    await write('go.work', 'go 1.24\n\nuse (\n\t./svc-a\n)\n')
    await write('svc-a/go.mod', 'module github.com/acme/svc-a\n')

    const { edges } = await harvestGo(scanDir)
    expect(edges.some(e => e.fromName === 'github.com/acme/svc-a' && e.edgeType === 'part_of')).toBe(
      true
    )
  })

  it('returns nothing for a repo with no go.mod', async () => {
    await write('README.md', '# nothing here\n')
    const { candidates } = await harvestGo(scanDir)
    expect(candidates).toHaveLength(0)
  })
})
