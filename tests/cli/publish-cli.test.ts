import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { parsePublishCommand, runPublishCommand } from '../../src/cli/publish-cli'

const originalNotionToken = process.env.NOTION_TOKEN
const originalNotionApiKey = process.env.NOTION_API_KEY
const originalOpenAiApiKey = process.env.OPENAI_API_KEY
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
const originalGeminiApiKey = process.env.GEMINI_API_KEY

afterEach(() => {
  vi.restoreAllMocks()
  if (originalNotionToken === undefined) {
    delete process.env.NOTION_TOKEN
  } else {
    process.env.NOTION_TOKEN = originalNotionToken
  }

  if (originalNotionApiKey === undefined) {
    delete process.env.NOTION_API_KEY
  } else {
    process.env.NOTION_API_KEY = originalNotionApiKey
  }

  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey
  }

  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  }

  if (originalGeminiApiKey === undefined) {
    delete process.env.GEMINI_API_KEY
  } else {
    process.env.GEMINI_API_KEY = originalGeminiApiKey
  }
})

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

  it('Given checkpoint and stop flags, then parses resume options', () => {
    const parsed = parsePublishCommand([
      '--base',
      'dogfood',
      '--checkpoint-file',
      '.tmp/publish-checkpoint.json',
      '--resume-from',
      '.tmp/publish-checkpoint.json',
      '--stop-after',
      'pass2',
    ])

    expect(parsed.checkpointFile).toBe('.tmp/publish-checkpoint.json')
    expect(parsed.resumeFrom).toBe('.tmp/publish-checkpoint.json')
    expect(parsed.stopAfter).toBe('pass2')
  })
})

describe('publish-cli dry run', () => {
  it.todo('Given markdown base directory, then returns package/import/restructure dry-run result — needs new publish architecture implementation')
})

describe('publish-cli apply', () => {
  it.todo('Given restructure apply without stage page id, then validates required input — needs phase-aware publish architecture')
  it.todo('Given apply all, then publishes markdown pages for raw import and generated wiki — needs phase-aware publish architecture')
  it.todo('Given stop-after package, then writes checkpoint and resume continues from it — needs checkpoint/resume publish architecture')

  it('Given a custom progress sink, then publish progress avoids direct stderr writes', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-publish-test-'))
    const baseDir = path.join(tempRoot, 'docs')
    const progressLines: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.GEMINI_API_KEY
      await mkdir(baseDir, { recursive: true })
      await writeFile(path.join(baseDir, 'overview.md'), '# Overview\n\nHello world\n', 'utf8')
      const db = new Database(path.join(baseDir, '.kb-index.sqlite'))
      db.exec(`
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          doc_type TEXT,
          lane TEXT,
          tags_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      db.prepare(`
        INSERT INTO documents (id, title, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('overview', 'Overview', '# Overview\n\nHello world\n', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      db.close()

      await runPublishCommand({
        ...parsePublishCommand(['--base', baseDir, '--dry-run']),
        progressSink(line) {
          progressLines.push(line.trim())
        },
      })

      expect(progressLines.some(line => line.startsWith('[publish]'))).toBe(true)
      expect(stderrSpy).not.toHaveBeenCalled()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
