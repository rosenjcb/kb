/**
 * Deterministic TS/JS code graph indexer using ts-morph.
 *
 * Extracts file nodes, symbol nodes, and typed edges (IMPORTS_FILE,
 * EXPORTS_SYMBOL, EXTENDS, IMPLEMENTS) into kg_* tables.
 */

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Node, Project } from 'ts-morph'
import { runMigrations } from '../core/db-migrations'
import { yieldEvery, yieldToEventLoop } from '../core/yield'

export type KgNodeKind = 'file' | 'symbol'
export type KgEdgeType = 'IMPORTS_FILE' | 'EXPORTS_SYMBOL' | 'EXTENDS' | 'IMPLEMENTS'

export interface CodeIndexStats {
  files: number
  symbols: number
  edges: number
  skipped: number
  errors: number
}

export interface CodeIndexOptions {
  onProgress?: (stats: CodeIndexStats) => void
  yieldEveryFiles?: number
  candidateFiles?: string[]
}

export interface LanguageIndexer {
  indexProject(repoRoot: string, opts?: CodeIndexOptions): Promise<CodeIndexStats>
  close(): void
}

const SCHEMA_VERSION = 1
const SOURCE = 'deterministic-ts'

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex')
}

function relPath(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).replace(/\\/g, '/')
}

function fileId(rel: string): string {
  return `file:${rel}`
}

function symbolId(rel: string, name: string): string {
  return `symbol:${rel}#${name}`
}

function detectLanguage(rel: string): string {
  if (rel.endsWith('.tsx')) return 'tsx'
  if (rel.endsWith('.ts')) return 'ts'
  if (rel.endsWith('.jsx')) return 'jsx'
  return 'js'
}

function hashFile(filePath: string): string {
  try {
    return crypto.createHash('sha1').update(readFileSync(filePath)).digest('hex')
  } catch {
    return ''
  }
}

export class TsMorphIndexer {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    runMigrations(this.db)
  }

  close(): void {
    this.db.close()
  }

  async indexProject(
    repoRoot: string,
    tsconfigPath: string,
    opts: CodeIndexOptions = {}
  ): Promise<CodeIndexStats> {
    const project = new Project({
      tsConfigFilePath: tsconfigPath,
      skipLoadingLibFiles: true,
      skipFileDependencyResolution: false,
    })
    await yieldToEventLoop()

    const stats: CodeIndexStats = { files: 0, symbols: 0, edges: 0, skipped: 0, errors: 0 }
    const yieldStride = opts.yieldEveryFiles ?? 10
    const candidateSet = opts.candidateFiles
      ? new Set(opts.candidateFiles.map(file => file.replace(/\\/g, '/')))
      : undefined

    // Use INSERT ... ON CONFLICT DO UPDATE (not INSERT OR REPLACE) to avoid
    // triggering ON DELETE CASCADE on edges that reference this node via to_id.
    // INSERT OR REPLACE does DELETE+INSERT which cascades; DO UPDATE patches in-place.
    const insertNode = this.db.prepare(`
      INSERT INTO kg_nodes
        (id, kind, subkind, name, qualified_name, path, file_id, language,
         span_start, span_end, exported, source, confidence, props_json,
         content_hash, updated_at)
      VALUES
        (@id, @kind, @subkind, @name, @qualifiedName, @path, @fileId, @language,
         @spanStart, @spanEnd, @exported, @source, @confidence, @propsJson,
         @contentHash, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        subkind = excluded.subkind,
        name = excluded.name,
        qualified_name = excluded.qualified_name,
        path = excluded.path,
        file_id = excluded.file_id,
        language = excluded.language,
        span_start = excluded.span_start,
        span_end = excluded.span_end,
        exported = excluded.exported,
        source = excluded.source,
        confidence = excluded.confidence,
        props_json = excluded.props_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `)

    const insertEdge = this.db.prepare(`
      INSERT OR REPLACE INTO kg_edges
        (id, from_id, to_id, type, source, confidence, props_json, updated_at)
      VALUES
        (@id, @fromId, @toId, @type, @source, @confidence, @propsJson, datetime('now'))
    `)

    // Stub-insert a file node so FK constraints on edges don't fail when the
    // target file hasn't been fully indexed yet in this pass.
    const stubFileNode = this.db.prepare(`
      INSERT OR IGNORE INTO kg_nodes
        (id, kind, name, qualified_name, path, source, confidence, props_json, updated_at)
      VALUES
        (@id, 'file', @name, @qualifiedName, @path, @source, @confidence, '{}', datetime('now'))
    `)

    const upsertFileState = this.db.prepare(`
      INSERT OR REPLACE INTO kg_file_state
        (file_id, path, content_hash, extractor, schema_version, indexed_at, success, error_text)
      VALUES
        (@fileId, @path, @contentHash, @extractor, @schemaVersion, datetime('now'), @success, @errorText)
    `)

    const insertFts = this.db.prepare(`
      INSERT OR REPLACE INTO kg_nodes_fts (id, name, qualified_name, path)
      VALUES (@id, @name, @qualifiedName, @path)
    `)

    // Delete only outgoing edges from this file's nodes; do NOT delete the file
    // node itself (that would cascade-delete import edges from other files).
    const deleteOutgoingEdges = this.db.prepare(`
      DELETE FROM kg_edges
      WHERE from_id = ?
        OR from_id IN (SELECT id FROM kg_nodes WHERE file_id = ?)
    `)
    const deleteSymbols = this.db.prepare('DELETE FROM kg_nodes WHERE file_id = ?')
    const deleteSymbolFts = this.db.prepare(`
      DELETE FROM kg_nodes_fts
      WHERE id = ? OR id IN (SELECT id FROM kg_nodes WHERE file_id = ?)
    `)

    const indexFile = this.db.transaction((sf: ReturnType<typeof project.getSourceFiles>[number]) => {
      const abs = sf.getFilePath()
      const rel = relPath(repoRoot, abs)
      const fid = fileId(rel)
      const lang = detectLanguage(rel)
      const contentHash = hashFile(abs)

      const existing = this.db
        .prepare('SELECT content_hash FROM kg_file_state WHERE file_id = ?')
        .get(fid) as { content_hash: string } | undefined
      if (existing?.content_hash === contentHash && contentHash !== '') {
        stats.skipped++
        return
      }

      deleteOutgoingEdges.run(fid, fid)
      deleteSymbols.run(fid)
      deleteSymbolFts.run(fid, fid)

      insertNode.run({
        id: fid,
        kind: 'file',
        subkind: null,
        name: path.basename(rel),
        qualifiedName: rel,
        path: rel,
        fileId: null,
        language: lang,
        spanStart: null,
        spanEnd: null,
        exported: 0,
        source: SOURCE,
        confidence: 1.0,
        propsJson: '{}',
        contentHash,
      })
      insertFts.run({ id: fid, name: path.basename(rel), qualifiedName: rel, path: rel })
      stats.files++

      for (const imp of sf.getImportDeclarations()) {
        const target = imp.getModuleSpecifierSourceFile()
        if (!target || target.isDeclarationFile() || target.isInNodeModules()) continue
        const targetRel = relPath(repoRoot, target.getFilePath())
        const targetId = fileId(targetRel)
        const specifier = imp.getModuleSpecifierValue()
        // Ensure target file node exists before inserting the edge
        stubFileNode.run({
          id: targetId,
          name: path.basename(targetRel),
          qualifiedName: targetRel,
          path: targetRel,
          source: SOURCE,
          confidence: 1.0,
        })
        insertEdge.run({
          id: sha1(`${fid}|IMPORTS_FILE|${targetId}`),
          fromId: fid,
          toId: targetId,
          type: 'IMPORTS_FILE',
          source: SOURCE,
          confidence: 0.98,
          propsJson: JSON.stringify({ specifier }),
        })
        stats.edges++
      }

      for (const [exportName, decls] of sf.getExportedDeclarations()) {
        if (!decls.length) continue
        const decl = decls[0]
        if (!decl) continue

        const sid = symbolId(rel, exportName)
        const subkind = decl.getKindName()

        insertNode.run({
          id: sid,
          kind: 'symbol',
          subkind,
          name: exportName,
          qualifiedName: `${rel}::${exportName}`,
          path: rel,
          fileId: fid,
          language: lang,
          spanStart: decl.getStart(),
          spanEnd: decl.getEnd(),
          exported: 1,
          source: SOURCE,
          confidence: 0.99,
          propsJson: '{}',
          contentHash: null,
        })
        insertFts.run({
          id: sid,
          name: exportName,
          qualifiedName: `${rel}::${exportName}`,
          path: rel,
        })
        stats.symbols++

        insertEdge.run({
          id: sha1(`${fid}|EXPORTS_SYMBOL|${sid}`),
          fromId: fid,
          toId: sid,
          type: 'EXPORTS_SYMBOL',
          source: SOURCE,
          confidence: 0.99,
          propsJson: '{}',
        })
        stats.edges++

        if (Node.isClassDeclaration(decl)) {
          const base = decl.getBaseClass()
          if (base) {
            const baseName = base.getName()
            const baseSourceFile = base.getSourceFile()
            if (baseName && baseSourceFile) {
              const baseRel = relPath(repoRoot, baseSourceFile.getFilePath())
              const baseSid = symbolId(baseRel, baseName)
              // Stub-insert base symbol node if it doesn't exist yet
              this.db.prepare(`
                INSERT OR IGNORE INTO kg_nodes
                  (id, kind, name, qualified_name, path, source, confidence, props_json, updated_at)
                VALUES (?, 'symbol', ?, ?, ?, ?, 0.99, '{}', datetime('now'))
              `).run(baseSid, baseName, `${baseRel}::${baseName}`, baseRel, SOURCE)
              insertEdge.run({
                id: sha1(`${sid}|EXTENDS|${baseSid}`),
                fromId: sid,
                toId: baseSid,
                type: 'EXTENDS',
                source: SOURCE,
                confidence: 0.95,
                propsJson: '{}',
              })
              stats.edges++
            }
          }

          for (const iface of decl.getImplements()) {
            const ifaceName = iface.getExpression().getText().split('<')[0] ?? ''
            if (!ifaceName) continue
            // Try to resolve the actual source file of the interface
            const ifaceSymbol = iface.getExpression().getSymbol()
            const ifaceDecl = ifaceSymbol?.getDeclarations()[0]
            const ifaceSourceFile = ifaceDecl?.getSourceFile() ?? sf
            const ifaceRel = relPath(repoRoot, ifaceSourceFile.getFilePath())
            const ifaceSid = symbolId(ifaceRel, ifaceName)
            this.db.prepare(`
              INSERT OR IGNORE INTO kg_nodes
                (id, kind, name, qualified_name, path, source, confidence, props_json, updated_at)
              VALUES (?, 'symbol', ?, ?, ?, ?, 0.99, '{}', datetime('now'))
            `).run(ifaceSid, ifaceName, `${ifaceRel}::${ifaceName}`, ifaceRel, SOURCE)
            insertEdge.run({
              id: sha1(`${sid}|IMPLEMENTS|${ifaceSid}`),
              fromId: sid,
              toId: ifaceSid,
              type: 'IMPLEMENTS',
              source: SOURCE,
              confidence: 0.95,
              propsJson: '{}',
            })
            stats.edges++
          }
        }
      }

      upsertFileState.run({
        fileId: fid,
        path: rel,
        contentHash,
        extractor: 'ts-morph',
        schemaVersion: SCHEMA_VERSION,
        success: 1,
        errorText: null,
      })
    })

    let processedFiles = 0
    for (const sf of project.getSourceFiles()) {
      if (sf.isDeclarationFile() || sf.isInNodeModules()) {
        stats.skipped++
        processedFiles += 1
        await yieldEvery(processedFiles, yieldStride)
        continue
      }
      if (candidateSet) {
        const rel = relPath(repoRoot, sf.getFilePath())
        if (!candidateSet.has(rel)) continue
      }
      try {
        indexFile(sf)
      } catch (err) {
        stats.errors++
        const abs = sf.getFilePath()
        const rel = relPath(repoRoot, abs)
        upsertFileState.run({
          fileId: fileId(rel),
          path: rel,
          contentHash: '',
          extractor: 'ts-morph',
          schemaVersion: SCHEMA_VERSION,
          success: 0,
          errorText: err instanceof Error ? err.message : String(err),
        })
      }
      processedFiles += 1
      opts.onProgress?.(stats)
      await yieldEvery(processedFiles, yieldStride)
    }

    return stats
  }
}
