/**
 * Deterministic TS/JS code graph indexer using ts-morph.
 *
 * Writes exported symbol facts, IMPORTS_FILE bridge facts, and structural
 * relationship facts (EXTENDS, IMPLEMENTS) into the facts table via SqliteKbIndexer.
 */

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Node, Project } from 'ts-morph'
import { runMigrations } from '../core/db-migrations'
import { yieldEvery, yieldToEventLoop } from '../core/yield'
import {
  getCodeFileState,
  tombstoneStaleCodeFacts,
  upsertCodeFileFact,
  upsertCodeFileState,
} from './code-fact-writer'
import type { SqliteKbIndexer } from './sqlite-kb-index'

export type KgNodeKind = 'file' | 'symbol'
export type KgEdgeType = 'IMPORTS_FILE' | 'EXPORTS_SYMBOL' | 'EXTENDS' | 'IMPLEMENTS'

export interface CodeIndexStats {
  files: number
  symbols: number
  edges: number
  skipped: number
  errors: number
  sourceRefs: Set<string>
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

const SOURCE = 'deterministic-ts'

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex')
}

function relPath(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).replace(/\\/g, '/')
}

function hashFile(filePath: string): string {
  try {
    return crypto.createHash('sha1').update(readFileSync(filePath)).digest('hex')
  } catch {
    return ''
  }
}

export class TsMorphIndexer {
  private db: DatabaseSync

  constructor(
    dbPath: string,
    private factIndexer: SqliteKbIndexer
  ) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
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

    const stats: CodeIndexStats = { files: 0, symbols: 0, edges: 0, skipped: 0, errors: 0, sourceRefs: new Set() }
    const yieldStride = opts.yieldEveryFiles ?? 10
    const candidateSet = opts.candidateFiles
      ? new Set(opts.candidateFiles.map(file => file.replace(/\\/g, '/')))
      : undefined

    // Ensure every candidate file is in the project regardless of tsconfig include/exclude.
    // Without this, files outside tsconfig's scope are silently skipped.
    if (opts.candidateFiles) {
      project.addSourceFilesAtPaths(opts.candidateFiles.map(f => path.join(repoRoot, f)))
    }

    const indexFile = (sf: ReturnType<typeof project.getSourceFiles>[number]) => {
      const abs = sf.getFilePath()
      const rel = relPath(repoRoot, abs)
      const contentHash = hashFile(abs)

      const existing = getCodeFileState(this.db, rel)
      if (existing?.content_hash === contentHash && contentHash !== '' && existing?.extractor === 'ts-morph') {
        stats.skipped++
        return
      }

      // Exported symbol facts
      for (const [exportName, decls] of sf.getExportedDeclarations()) {
        if (!decls.length) continue
        const decl = decls[0]
        if (!decl) continue

        const subkind = decl.getKindName().replace(/Declaration$/, '')
        const rawText = decl.getText()
        const sourceText = rawText.length > 1500 ? `${rawText.slice(0, 1497)}…` : rawText
        const sourceRef = `ast:${rel}@${exportName}`
        stats.sourceRefs.add(sourceRef)

        // For variable declarations (constants), include value in fact text
        let factText = `${exportName} is a ${subkind} exported from ${rel}`
        if (Node.isVariableDeclaration(decl)) {
          const valueText = extractSimpleInitializerText(decl.getInitializer()?.getText())
          if (valueText) factText = `${exportName} is a constant with value ${valueText} exported from ${rel}`
        }

        upsertCodeFileFact(
          this.factIndexer,
          sourceRef,
          factText,
          { subject: exportName, predicate: 'exported_from', object: rel },
          0.65,
          sourceText
        )
        stats.symbols++
      }

      // Module-level non-exported constants with literal values
      for (const vs of sf.getVariableStatements()) {
        if (vs.isExported()) continue
        if (vs.getDeclarationKind().toString() !== 'const') continue
        for (const vd of vs.getDeclarations()) {
          const name = vd.getName()
          const valueText = extractSimpleInitializerText(vd.getInitializer()?.getText())
          if (!valueText) continue
          const sourceRef = `ast:const:${rel}@${name}`
          stats.sourceRefs.add(sourceRef)
          upsertCodeFileFact(
            this.factIndexer,
            sourceRef,
            `${name} is a constant with value ${valueText} in ${rel}`,
            { subject: name, predicate: 'defined_in', object: rel },
            0.6,
            vd.getText()
          )
          stats.symbols++
        }
      }

      // IMPORTS_FILE facts (bridges between file clusters)
      for (const imp of sf.getImportDeclarations()) {
        const target = imp.getModuleSpecifierSourceFile()
        if (!target || target.isDeclarationFile() || target.isInNodeModules()) continue
        const targetRel = relPath(repoRoot, target.getFilePath())
        const sourceRef = `ast:import:${sha1(`${rel}→${targetRel}`)}`
        stats.sourceRefs.add(sourceRef)
        upsertCodeFileFact(
          this.factIndexer,
          sourceRef,
          `${rel} imports ${targetRel}`,
          { subject: rel, predicate: 'imports', object: targetRel },
          0.3
        )
        stats.edges++
      }

      // EXTENDS / IMPLEMENTS structural facts
      for (const [exportName, decls] of sf.getExportedDeclarations()) {
        if (!decls.length) continue
        const decl = decls[0]
        if (!decl || !Node.isClassDeclaration(decl)) continue

        const base = decl.getBaseClass()
        if (base) {
          const baseName = base.getName()
          const baseSourceFile = base.getSourceFile()
          if (baseName && baseSourceFile) {
            const sourceRef = `ast:edge:${sha1(`${rel}@${exportName}:extends:${baseName}`)}`
            stats.sourceRefs.add(sourceRef)
            upsertCodeFileFact(
              this.factIndexer,
              sourceRef,
              `${exportName} extends ${baseName} in ${rel}`,
              { subject: exportName, predicate: 'extends', object: baseName },
              0.7
            )
            stats.edges++
          }
        }

        for (const iface of decl.getImplements()) {
          const ifaceName = iface.getExpression().getText().split('<')[0] ?? ''
          if (!ifaceName) continue
          const sourceRef = `ast:edge:${sha1(`${rel}@${exportName}:implements:${ifaceName}`)}`
          stats.sourceRefs.add(sourceRef)
          upsertCodeFileFact(
            this.factIndexer,
            sourceRef,
            `${exportName} implements ${ifaceName} in ${rel}`,
            { subject: exportName, predicate: 'implements', object: ifaceName },
            0.7
          )
          stats.edges++
        }
      }

      upsertCodeFileState(this.db, rel, contentHash, 'ts-morph')
      stats.files++
    }

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
      } catch {
        stats.errors++
      }
      processedFiles += 1
      opts.onProgress?.(stats)
      await yieldEvery(processedFiles, yieldStride)
    }

    return stats
  }
}

/** Tombstone facts for files no longer in the repo. Call after both indexers finish.
 *  Scoped to `gitRepo` so re-indexing one repo never tombstones another repo's code facts. */
export function tombstoneStaleAstFacts(
  factIndexer: SqliteKbIndexer,
  allSourceRefs: Set<string>,
  gitRepo?: string
): number {
  return tombstoneStaleCodeFacts(factIndexer, allSourceRefs, gitRepo)
}

// Re-export SOURCE constant for compatibility
export { SOURCE as DETERMINISTIC_TS_SOURCE }

/**
 * Returns a concise string for simple literal initializers (numbers, strings, booleans,
 * short arithmetic/template expressions). Returns undefined for complex expressions.
 */
function extractSimpleInitializerText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (trimmed.length > 120) return undefined
  // Accept: numeric literals, string literals, booleans, simple arithmetic, arrays of literals
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed
  if (/^['"`]/.test(trimmed)) return trimmed.slice(0, 80)
  if (trimmed === 'true' || trimmed === 'false') return trimmed
  // Short expressions that look like formulas (contain operators but no function calls)
  if (trimmed.length <= 60 && /[\d]/.test(trimmed) && !/[({]/.test(trimmed)) return trimmed
  return undefined
}
