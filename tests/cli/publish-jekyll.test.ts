import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseJekyllPublishOptions, runJekyllPublish } from '../../src/cli/publish-jekyll'
import { docToCollectionFilename } from '../../src/core/publish/jekyll-sync'

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

async function makeSqliteDbWithFacts(
  baseDir: string,
  facts: Array<{ id: string; subject: string; predicate: string; object: string }>
) {
  const db = new Database(path.join(baseDir, '.kb-index.sqlite'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS derived_docs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL,
      markdown TEXT NOT NULL, source_fact_ids_json TEXT NOT NULL, status TEXT NOT NULL,
      tags_json TEXT, doc_type TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS original_docs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, markdown TEXT NOT NULL,
      source_ref TEXT, tags_json TEXT, doc_type TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, fact_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
      source_kind TEXT NOT NULL, source_ref TEXT, confidence REAL NOT NULL DEFAULT 0.8,
      supersedes_fact_id TEXT, tombstoned_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      lane_id TEXT NOT NULL DEFAULT 'general',
      subject TEXT NOT NULL DEFAULT '', predicate TEXT NOT NULL DEFAULT '', object TEXT NOT NULL DEFAULT ''
    );
  `)
  for (const f of facts) {
    db.prepare(
      'INSERT INTO facts (id, fact_text, normalized_text, source_kind, created_at, updated_at, subject, predicate, object) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(f.id, f.id, f.id, 'test', '2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z', f.subject, f.predicate, f.object)
  }
  db.close()
}

async function makeSqliteDb(
  baseDir: string,
  docs: Array<{ id: string; title: string; content: string; is_original?: number }>
) {
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
  for (const doc of docs) {
    if ((doc.is_original ?? 0) === 1) {
      db.prepare(
        'INSERT INTO original_docs (id, title, markdown, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        doc.id,
        doc.title,
        doc.content,
        doc.id,
        '2026-01-15T10:00:00.000Z',
        '2026-01-15T10:00:00.000Z'
      )
    } else {
      db.prepare(
        'INSERT INTO derived_docs (id, title, instruction, markdown, source_fact_ids_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        doc.id,
        doc.title,
        'test instruction',
        doc.content,
        '[]',
        'active',
        '2026-01-15T10:00:00.000Z',
        '2026-01-15T10:00:00.000Z'
      )
    }
  }
  db.close()
}

describe('parseJekyllPublishOptions', () => {
  it('Given no flags, then defaults to preview (no apply) and cwd for dir', () => {
    const opts = parseJekyllPublishOptions([], '/workspace')
    expect(opts.apply).toBe(false)
    expect(opts.dir).toBe('/workspace')
  })

  it('Given --dir flag, then uses provided path', () => {
    const opts = parseJekyllPublishOptions(['--dir', '/my/jekyll'], '/workspace')
    expect(opts.dir).toBe('/my/jekyll')
  })

  it('Given --apply flag, then sets apply', () => {
    const opts = parseJekyllPublishOptions(['--apply'], '/workspace')
    expect(opts.apply).toBe(true)
  })
})

describe('runJekyllPublish preview', () => {
  it('Given a valid Jekyll dir and SQLite base, then returns preview result without writing files', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'site')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeJekyllSite(siteDir)
    await makeSqliteDb(baseDir, [
      { id: 'doc-1', title: 'Hello World', content: '# Hello World\n\nBody.' },
    ])

    const result = await runJekyllPublish({ base: baseDir, dir: siteDir, apply: false }, tempDir)

    expect(result.status).toBe('preview')
    expect(result.totalDocs).toBe(1)
    expect(result.written).toHaveLength(1)
    expect(result.written[0].title).toBe('Hello World')
    // no _autogenerated_docs dir written in preview
    await expect(readdir(path.join(siteDir, '_autogenerated_docs'))).rejects.toThrow()
  })
})

describe('runJekyllPublish apply', () => {
  it('Given a valid Jekyll dir and SQLite base, then writes autogenerated_docs and returns accepted', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'site')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeJekyllSite(siteDir)
    await makeSqliteDb(baseDir, [
      { id: 'doc-1', title: 'Hello World', content: '# Hello World\n\nBody.' },
      { id: 'doc-2', title: 'Second Doc', content: '# Second Doc\n\nMore content.' },
    ])

    const result = await runJekyllPublish({ base: baseDir, dir: siteDir, apply: true }, tempDir)

    expect(result.status).toBe('accepted')
    expect(result.totalDocs).toBe(2)
    expect(result.written).toHaveLength(2)
    expect(result.graphPagePath).toBe(path.join(siteDir, '_graph_pages/knowledge-graph.md'))
    expect(result.graphDataPath).toBe(path.join(siteDir, 'assets', 'generated', 'kb-graph.json'))

    const files = await readdir(path.join(siteDir, '_autogenerated_docs'))
    expect(files).toHaveLength(2)
    const graphPage = await readdir(path.join(siteDir, 'assets', 'generated'))
    expect(graphPage).toContain('kb-graph.json')
  })

  it('Given is_original docs, then routes them to _original_docs and autogenerated to _autogenerated_docs', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'site')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeJekyllSite(siteDir)
    await makeSqliteDb(baseDir, [
      { id: 'orig-1', title: 'README', content: '# README\n\nProject docs.', is_original: 1 },
      {
        id: 'gen-1',
        title: 'Architecture Overview',
        content: '# Architecture\n\nGenerated.',
        is_original: 0,
      },
    ])

    await runJekyllPublish({ base: baseDir, dir: siteDir, apply: true }, tempDir)

    const originalFiles = await readdir(path.join(siteDir, '_original_docs'))
    const autogenFiles = await readdir(path.join(siteDir, '_autogenerated_docs'))
    expect(originalFiles).toHaveLength(1)
    expect(autogenFiles).toHaveLength(1)
  })

  it('Given a dir with no _config.yml, then throws with helpful error', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'no-jekyll')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeSqliteDb(baseDir, [])

    await expect(
      runJekyllPublish({ base: baseDir, dir: siteDir, apply: false }, tempDir)
    ).rejects.toThrow('No Jekyll project found')
  })

  it('Given an empty SQLite base, then returns warning about no docs', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'site')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeJekyllSite(siteDir)
    await makeSqliteDb(baseDir, [])

    const result = await runJekyllPublish({ base: baseDir, dir: siteDir, apply: false }, tempDir)

    expect(result.warnings.some(w => w.includes('kb init'))).toBe(true)
  })

  it('Given facts with edges whose target is a non-entity value, then kb-graph.json contains no dangling edges', async () => {
    const baseDir = path.join(tempDir, 'base')
    const siteDir = path.join(tempDir, 'site')
    await mkdir(baseDir, { recursive: true })
    await mkdir(siteDir, { recursive: true })
    await makeJekyllSite(siteDir)
    // EntityA --exported_from--> src/cli/base-selection.ts (file path, not an entity)
    // EntityA --relates_to--> EntityB (both are subjects, so both are entities)
    await makeSqliteDbWithFacts(baseDir, [
      { id: 'f1', subject: 'EntityA', predicate: 'exported_from', object: 'src/cli/base-selection.ts' },
      { id: 'f2', subject: 'EntityA', predicate: 'relates_to', object: 'EntityB' },
      { id: 'f3', subject: 'EntityB', predicate: 'exported_from', object: 'src/cli/base-selection.ts' },
    ])

    await runJekyllPublish({ base: baseDir, dir: siteDir, apply: true }, tempDir)

    const raw = await readFile(path.join(siteDir, 'assets', 'generated', 'kb-graph.json'), 'utf8')
    const payload = JSON.parse(raw)
    const entityIds = new Set((payload.entities as Array<{ id: string }>).map(e => e.id))

    // file path target should not appear as an entity
    expect(entityIds.has('src/cli/base-selection.ts')).toBe(false)

    // every edge must reference existing node IDs
    for (const rel of payload.relationships as Array<{ fromId: string; toId: string }>) {
      expect(entityIds.has(rel.fromId)).toBe(true)
      expect(entityIds.has(rel.toId)).toBe(true)
    }

    // the valid entity-to-entity edge should still be present
    const validEdge = (payload.relationships as Array<{ fromId: string; toId: string }>).find(
      r => r.fromId === 'EntityA' && r.toId === 'EntityB'
    )
    expect(validEdge).toBeDefined()
  })
})

describe('docToCollectionFilename', () => {
  it('simple title becomes slug', () => {
    expect(docToCollectionFilename({ title: 'Agent Loop' })).toBe('agent-loop.md')
  })

  it('path-style title uses full path as slug to avoid basename collisions', () => {
    expect(docToCollectionFilename({ title: 'src/core/AGENT_LOOP.md' })).toBe(
      'src-core-agent-loop.md'
    )
  })

  it('strips .md extension before slugifying', () => {
    expect(docToCollectionFilename({ title: 'README.md' })).toBe('readme.md')
  })

  it('nested path includes directory components in slug', () => {
    expect(docToCollectionFilename({ title: 'src/core/TUI.md' })).toBe('src-core-tui.md')
  })
})
