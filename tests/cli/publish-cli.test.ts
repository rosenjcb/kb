import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
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
  it('Given markdown base directory, then returns package/import/restructure dry-run result', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-publish-test-'))
    const baseDir = path.join(tempRoot, 'docs')

    try {
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.GEMINI_API_KEY
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

describe('publish-cli apply', () => {
  it('Given restructure apply without stage page id, then validates required input', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-publish-test-'))
    const baseDir = path.join(tempRoot, 'docs')

    try {
      process.env.NOTION_TOKEN = 'test-token'
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.GEMINI_API_KEY
      await mkdir(baseDir, { recursive: true })
      await writeFile(path.join(baseDir, 'overview.md'), '# Overview\n\nHello world\n', 'utf8')

      await expect(runPublishCommand(
        parsePublishCommand([
          '--base',
          baseDir,
          '--phase',
          'restructure',
          '--apply',
        ]),
      )).rejects.toThrow('Restructure phase requires --stage-page-id when not running import in the same command.')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('Given apply all, then publishes markdown pages for raw import and generated wiki', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-publish-test-'))
    const baseDir = path.join(tempRoot, 'docs')
    const requestBodies: Array<Record<string, unknown>> = []

    try {
      process.env.NOTION_TOKEN = 'test-token'
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.GEMINI_API_KEY
      await mkdir(baseDir, { recursive: true })
      await writeFile(path.join(baseDir, 'overview.md'), '# Overview\n\nHello world\n', 'utf8')
      await writeFile(path.join(baseDir, 'policy.md'), '# Policy\n\nFollow the rules.\n', 'utf8')

      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        requestBodies.push(body)

        const titleProperty = body.properties as { title?: { title?: Array<{ text?: { content?: string } }> } }
        const title = titleProperty.title?.title?.[0]?.text?.content ?? 'Untitled'
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')

        return new Response(
          JSON.stringify({
            id: `${slug}-id`,
            url: `https://notion.so/${slug}`,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }))

      const result = await runPublishCommand(
        parsePublishCommand([
          '--base',
          baseDir,
          '--phase',
          'all',
          '--apply',
        ]),
      )

      expect(result.notion?.importedPages).toBe(2)
      expect(result.notion?.reorganizedPages).toBeGreaterThan(0)

      const rawImportDoc = requestBodies.find(body => body.markdown === '# Overview\n\nHello world\n')
      expect(rawImportDoc).toBeTruthy()

      const overviewWiki = requestBodies.find(body => {
        const titleProperty = body.properties as { title?: { title?: Array<{ text?: { content?: string } }> } }
        const title = titleProperty.title?.title?.[0]?.text?.content
        return title === 'Overview'
      })
      expect(String(overviewWiki?.markdown ?? '')).toContain('## Main ideas')
      expect(String(overviewWiki?.markdown ?? '')).not.toContain("import os from 'node:os'")
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('Given stop-after package, then writes checkpoint and resume continues from it', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-publish-test-'))
    const baseDir = path.join(tempRoot, 'docs')
    const checkpointFile = path.join(tempRoot, 'publish.checkpoint.json')

    try {
      delete process.env.OPENAI_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.GEMINI_API_KEY
      await mkdir(baseDir, { recursive: true })
      await writeFile(path.join(baseDir, 'overview.md'), '# Overview\n\nHello world\n', 'utf8')

      const paused = await runPublishCommand(
        parsePublishCommand([
          '--base',
          baseDir,
          '--phase',
          'all',
          '--dry-run',
          '--checkpoint-file',
          checkpointFile,
          '--stop-after',
          'package',
        ]),
      )

      expect(paused.status).toBe('paused')
      expect(paused.checkpointFile).toBe(checkpointFile)

      const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')) as {
        completedSteps: string[]
        artifact?: { includedCount?: number }
      }
      expect(checkpoint.completedSteps).toContain('package')
      expect(checkpoint.artifact?.includedCount).toBe(1)

      const resumed = await runPublishCommand(
        parsePublishCommand([
          '--base',
          baseDir,
          '--phase',
          'all',
          '--dry-run',
          '--resume-from',
          checkpointFile,
        ]),
      )

      expect(resumed.status).toBe('accepted')
      expect(resumed.resumedFrom).toBe(checkpointFile)
      expect(resumed.artifact?.includedCount).toBe(1)
      expect(resumed.notion?.stagePageId).toBe('dry-run-stage-page-id')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

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
