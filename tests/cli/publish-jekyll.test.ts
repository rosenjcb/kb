import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseJekyllPublishOptions, runJekyllPublish } from '../../src/cli/publish-jekyll'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'kb-jekyll-cli-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function makeJekyllSite(root: string) {
  return writeFile(path.join(root, '_config.yml'), 'title: Test Site\n', 'utf8')
}

async function makeSqliteDb(
  baseDir: string,
  docs: Array<{ id: string; title: string; content: string; is_original?: number }>
) {
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
      updated_at TEXT NOT NULL,
      is_original INTEGER NOT NULL DEFAULT 0
    );
  `)
  const insert = db.prepare(
    'INSERT INTO documents (id, title, content, created_at, updated_at, is_original) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const doc of docs) {
    insert.run(doc.id, doc.title, doc.content, '2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z', doc.is_original ?? 0)
  }
  db.close()
}

describe('parseJekyllPublishOptions', () => {
  it('Given no flags, then defaults to dry-run and cwd for dir', () => {
    const opts = parseJekyllPublishOptions([], '/workspace')
    expect(opts.dryRun).toBe(true)
    expect(opts.apply).toBe(false)
    expect(opts.dir).toBe('/workspace')
  })

  it('Given --dir flag, then uses provided path', () => {
    const opts = parseJekyllPublishOptions(['--dir', '/my/jekyll'], '/workspace')
    expect(opts.dir).toBe('/my/jekyll')
  })

  it('Given --apply flag, then sets apply and clears dryRun', () => {
    const opts = parseJekyllPublishOptions(['--apply'], '/workspace')
    expect(opts.apply).toBe(true)
    expect(opts.dryRun).toBe(false)
  })

  it('Given both --apply and --dry-run, then throws', () => {
    expect(() => parseJekyllPublishOptions(['--apply', '--dry-run'], '/workspace')).toThrow(
      'Use either --apply or --dry-run, not both'
    )
  })
})

describe('runJekyllPublish dry-run', () => {
  it('Given a valid Jekyll dir and SQLite base, then returns dry-run result without writing files', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'site')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeJekyllSite(siteDir)
    await makeSqliteDb(baseDir, [
      { id: 'doc-1', title: 'Hello World', content: '# Hello World\n\nBody.' },
    ])

    const result = await runJekyllPublish(
      { base: baseDir, dir: siteDir, apply: false, dryRun: true },
      tempDir
    )

    expect(result.status).toBe('dry-run')
    expect(result.totalDocs).toBe(1)
    expect(result.written).toHaveLength(1)
    expect(result.written[0].title).toBe('Hello World')
    expect(result.publishedPostsData).toBeUndefined()
    // no _posts dir written
    await expect(readdir(path.join(siteDir, '_posts'))).rejects.toThrow()
  })
})

describe('runJekyllPublish apply', () => {
  it('Given a valid Jekyll dir and SQLite base, then writes posts and returns accepted', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'site')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeJekyllSite(siteDir)
    await makeSqliteDb(baseDir, [
      { id: 'doc-1', title: 'Hello World', content: '# Hello World\n\nBody.' },
      { id: 'doc-2', title: 'Second Post', content: '# Second Post\n\nMore content.' },
    ])

    const result = await runJekyllPublish(
      { base: baseDir, dir: siteDir, apply: true, dryRun: false },
      tempDir
    )

    expect(result.status).toBe('accepted')
    expect(result.totalDocs).toBe(2)
    expect(result.written).toHaveLength(2)
    expect(result.publishedPostsData).toBe(path.join(siteDir, '_data', 'kb_published_posts.yml'))

    const files = await readdir(path.join(siteDir, '_posts'))
    expect(files).toHaveLength(2)
  })

  it('Given a dir with no _config.yml, then throws with helpful error', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'no-jekyll')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeSqliteDb(baseDir, [])

    await expect(
      runJekyllPublish({ base: baseDir, dir: siteDir, apply: false, dryRun: true }, tempDir)
    ).rejects.toThrow('No Jekyll project found')
  })

  it('Given an empty SQLite base, then returns warning about no docs', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'site')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeJekyllSite(siteDir)
    await makeSqliteDb(baseDir, [])

    const result = await runJekyllPublish(
      { base: baseDir, dir: siteDir, apply: false, dryRun: true },
      tempDir
    )

    expect(result.warnings.some(w => w.includes('kb init'))).toBe(true)
  })
})
