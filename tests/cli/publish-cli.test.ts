import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parsePublishCommand, runPublishCommand } from '../../src/cli/publish-cli'

describe('publish-cli parser', () => {
  it('Given no apply flag, then defaults to dry-run notion all phase', () => {
    const parsed = parsePublishCommand(['--base', 'dogfood'])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.provider).toBe('notion')
    expect(parsed.phase).toBe('all')
    expect(parsed.dryRun).toBe(true)
    expect(parsed.apply).toBe(false)
  })

  it('Given apply and phase import, then parses explicit execution mode', () => {
    const parsed = parsePublishCommand(['--base', 'dogfood', '--phase', 'import', '--apply'])

    expect(parsed.phase).toBe('import')
    expect(parsed.apply).toBe(true)
    expect(parsed.dryRun).toBe(false)
  })

  it('Given unsupported provider, then throws explicit error', () => {
    expect(() => parsePublishCommand(['--provider', 'other'])).toThrow(
      'Only --provider notion is supported in v1',
    )
  })
})

describe('publish-cli dry run', () => {
  it('Given markdown base directory, then returns package/import/restructure dry-run result', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-publish-test-'))
    const baseDir = path.join(tempRoot, 'docs')

    try {
      await mkdir(baseDir, { recursive: true })
      await writeFile(path.join(baseDir, 'overview.md'), '# Overview\n\nHello world\n', 'utf8')
      await writeFile(path.join(baseDir, '.kb-index.sqlite'), 'not-used', 'utf8')

      const result = await runPublishCommand(
        parsePublishCommand([
          '--base',
          baseDir,
          '--phase',
          'all',
          '--dry-run',
        ]),
      )

      expect(result.status).toBe('accepted')
      expect(result.artifact?.includedCount).toBe(1)
      expect(result.artifact?.excludedCount).toBeGreaterThanOrEqual(1)
      expect(result.notion?.stagePageId).toBe('dry-run-stage-page-id')
      expect(result.operatorPrompt?.pack).toBe('notion-v1')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
