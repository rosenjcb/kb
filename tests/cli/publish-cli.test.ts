import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync as Database } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parsePublishCommand,
  runPublishCommand,
} from '@kb/core/cli/publish-cli.js'

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
  it('[TC-344] Given no apply flag, then defaults to preview (apply=false)', () => {
    const parsed = parsePublishCommand(['--base', 'dogfood'])

    expect(parsed.base).toBe('dogfood')
    expect(parsed.phase).toBe('all')
    expect(parsed.apply).toBe(false)
  })

  it('[TC-345] Given apply and phase import, then parses explicit execution mode', () => {
    const parsed = parsePublishCommand(['--base', 'dogfood', '--phase', 'import', '--apply'])

    expect(parsed.phase).toBe('import')
    expect(parsed.apply).toBe(true)
  })

  it('[TC-346] Given checkpoint and stop flags, then parses resume options', () => {
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

describe('publish-cli preview', () => {
  it.todo(
    'Given markdown base directory, then returns package/import/restructure preview result — needs new publish architecture implementation'
  )
})

describe('publish-cli apply', () => {
  it.todo(
    'Given restructure apply without stage page id, then validates required input — needs phase-aware publish architecture'
  )
  it.todo(
    'Given apply all, then publishes markdown pages for raw import and generated wiki — needs phase-aware publish architecture'
  )
  it.todo(
    'Given stop-after package, then writes checkpoint and resume continues from it — needs checkpoint/resume publish architecture'
  )

  it('[TC-347] Given a custom progress sink, then publish progress avoids direct stderr writes', async () => {
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
        CREATE TABLE derived_docs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          instruction TEXT NOT NULL,
          markdown TEXT NOT NULL,
          source_fact_ids_json TEXT NOT NULL,
          status TEXT NOT NULL,
          tags_json TEXT,
          doc_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE original_docs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          markdown TEXT NOT NULL,
          source_ref TEXT,
          tags_json TEXT,
          doc_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      db.prepare(
        `INSERT INTO derived_docs (id, title, instruction, markdown, source_fact_ids_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'overview',
        'Overview',
        'init',
        '# Overview\n\nHello world\n',
        '[]',
        'active',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
      db.close()

      const dry = await runPublishCommand({
        ...parsePublishCommand(['--base', baseDir]),
        progressSink(line) {
          progressLines.push(line.trim())
        },
      })

      expect(dry.publishedPages[0]?.title).toBe('Original Documents')
      expect(dry.publishedPages[0]?.pageRole).toBe('section')
      expect(dry.publishedPages[1]?.title).toBe('Autogenerated Documents')
      expect(dry.publishedPages.find(p => p.id === 'overview')?.section).toBe('autogenerated')
      expect(dry.removedPages).toEqual([])
      expect(progressLines.some(line => line.startsWith('[publish]'))).toBe(true)
      expect(stderrSpy).not.toHaveBeenCalled()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('[TC-348] Given notion state with stale pages, then preview reports removedPages', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-publish-preview-remove-'))
    const baseDir = path.join(tempRoot, 'base')
    const fetchMock = vi.fn()

    try {
      vi.stubGlobal('fetch', fetchMock)
      await mkdir(baseDir, { recursive: true })

      await writeFile(
        path.join(baseDir, '.kb-publish-notion.json'),
        `${JSON.stringify({
          version: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
          baseName: 'base',
          containerPageId: 'container-1',
          originalSectionPageId: 'section-original',
          autogeneratedSectionPageId: 'section-autogen',
        })}\n`,
        'utf8'
      )

      const db = new Database(path.join(baseDir, '.kb-index.sqlite'))
      db.exec(`
        CREATE TABLE derived_docs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          instruction TEXT NOT NULL,
          markdown TEXT NOT NULL,
          source_fact_ids_json TEXT NOT NULL,
          status TEXT NOT NULL,
          tags_json TEXT,
          doc_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE original_docs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          markdown TEXT NOT NULL,
          source_ref TEXT,
          tags_json TEXT,
          doc_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      db.prepare(
        `INSERT INTO derived_docs (id, title, instruction, markdown, source_fact_ids_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'kept',
        'Kept Doc',
        'init',
        '# Kept Doc\n\nStill here.',
        '[]',
        'active',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
      db.close()

      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/blocks/section-autogen/children')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [{ id: 'page-stale', type: 'child_page' }],
              has_more: false,
            }),
          } as Response
        }
        if (url.includes('/blocks/section-original/children')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ results: [], has_more: false }),
          } as Response
        }
        if (url.includes('/pages/page-stale')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              properties: { title: { title: [{ plain_text: 'Removed Doc' }] } },
            }),
          } as Response
        }
        throw new Error(`Unexpected fetch: ${url}`)
      })

      const preview = await runPublishCommand({
        ...parsePublishCommand(['--base', baseDir]),
      })

      expect(preview.removedPages).toEqual([
        { id: 'page-stale', title: 'Removed Doc', section: 'autogenerated' },
      ])
    } finally {
      vi.unstubAllGlobals()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('[TC-349] Given apply with notion state, then archives stale pages and returns removedPages', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-publish-apply-remove-'))
    const baseDir = path.join(tempRoot, 'base')
    const fetchMock = vi.fn()
    const archived: string[] = []

    try {
      vi.stubGlobal('fetch', fetchMock)
      process.env.NOTION_TOKEN = 'test-token'
      process.env.NOTION_PARENT_PAGE_ID = 'parent-1'

      await mkdir(baseDir, { recursive: true })
      await writeFile(
        path.join(baseDir, '.kb-publish-notion.json'),
        `${JSON.stringify({
          version: 1,
          updatedAt: '2026-01-01T00:00:00.000Z',
          baseName: 'base',
          containerPageId: 'container-1',
          containerUrl: 'https://notion.so/container-1',
          originalSectionPageId: 'section-original',
          autogeneratedSectionPageId: 'section-autogen',
        })}\n`,
        'utf8'
      )

      const db = new Database(path.join(baseDir, '.kb-index.sqlite'))
      db.exec(`
        CREATE TABLE derived_docs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          instruction TEXT NOT NULL,
          markdown TEXT NOT NULL,
          source_fact_ids_json TEXT NOT NULL,
          status TEXT NOT NULL,
          tags_json TEXT,
          doc_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE original_docs (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          markdown TEXT NOT NULL,
          source_ref TEXT,
          tags_json TEXT,
          doc_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      db.close()

      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'

        if (url.includes('/blocks/section-autogen/children')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [{ id: 'page-stale', type: 'child_page' }],
              has_more: false,
            }),
          } as Response
        }
        if (url.includes('/blocks/section-original/children')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ results: [], has_more: false }),
          } as Response
        }
        if (url.includes('/pages/page-stale') && method === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              properties: { title: { title: [{ plain_text: 'Removed Doc' }] } },
            }),
          } as Response
        }
        if (method === 'PATCH' && url.includes('/pages/page-stale')) {
          archived.push('page-stale')
          return { ok: true, status: 200, json: async () => ({ id: 'page-stale' }) } as Response
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`)
      })

      const result = await runPublishCommand({
        ...parsePublishCommand(['--base', baseDir, '--apply']),
      })

      expect(archived).toEqual(['page-stale'])
      expect(result.removedPages).toEqual([
        { id: 'page-stale', title: 'Removed Doc', section: 'autogenerated' },
      ])
      expect(result.status).toBe('accepted')
    } finally {
      vi.unstubAllGlobals()
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
