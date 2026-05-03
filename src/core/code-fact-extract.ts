import { createHash } from 'node:crypto'
import path from 'node:path'
import { loadPrompt } from '../prompts/loader'
import type { LLMProvider } from './types'
import { SqliteKbIndexer, type FactRow, type FactTriplet } from '../tools/sqlite-kb-index'

// ─── Skeleton ──────────────────────────────────────────────────────────────

export interface CodeExportSymbol {
  /** `function | class | const | let | var | type | interface | enum | default` */
  kind: string
  name: string
  line: number
}

export interface CodeImport {
  source: string
  names: string[]
}

export interface CodeSkeleton {
  filePath: string
  language: string
  loc: number
  /** Leading JSDoc-style block above the first code, if present. */
  leadingDoc: string | null
  exports: CodeExportSymbol[]
  imports: CodeImport[]
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.java': 'java',
  '.rs': 'rust',
  '.swift': 'swift',
  '.kt': 'kotlin',
}

function detectLanguage(filePath: string): string {
  return LANG_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'unknown'
}

/** TS / JS export keywords that introduce a named symbol. */
const TS_EXPORT_RE =
  /^export\s+(?:default\s+(?:async\s+)?(function\*?|class)\s+([A-Za-z_$][\w$]*)|(?:async\s+)?(function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*))/

const TS_EXPORT_DEFAULT_ANON_RE = /^export\s+default\s+/
const TS_IMPORT_RE = /^import\s+(?:([^'"]+?)\s+from\s+)?['"]([^'"]+)['"]/

const PY_DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/
const PY_CLASS_RE = /^class\s+([A-Za-z_][\w]*)\b/
const PY_IMPORT_RE = /^(?:from\s+([\w.]+)\s+import\s+([\w*,\s]+)|import\s+([\w.,\s]+))/

const GO_FUNC_RE = /^func\s+(?:\([^)]*\)\s+)?([A-Z][\w]*)\s*\(/
const GO_TYPE_RE = /^type\s+([A-Z][\w]*)\b/

const RS_PUB_FN_RE = /^pub\s+(?:async\s+)?fn\s+([A-Za-z_][\w]*)\b/
const RS_PUB_STRUCT_RE = /^pub\s+(?:struct|enum|trait|type)\s+([A-Za-z_][\w]*)\b/

function extractTsImports(lines: string[]): CodeImport[] {
  const imports: CodeImport[] = []
  for (const raw of lines.slice(0, 200)) {
    const line = raw.trim()
    const m = TS_IMPORT_RE.exec(line)
    if (!m) continue
    const namesRaw = (m[1] ?? '').trim()
    const source = m[2] ?? ''
    const names = namesRaw
      ? namesRaw
          .replace(/[{}]/g, '')
          .split(',')
          .map(s => s.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
          .filter(Boolean)
      : []
    imports.push({ source, names })
  }
  return imports
}

function extractTsExports(lines: string[]): CodeExportSymbol[] {
  const exports: CodeExportSymbol[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    const m = TS_EXPORT_RE.exec(trimmed)
    if (m) {
      const kind = (m[1] ?? m[3] ?? '').replace('*', '').trim()
      const name = (m[2] ?? m[4] ?? '').trim()
      if (kind && name) {
        exports.push({ kind, name, line: i + 1 })
      }
      continue
    }
    if (TS_EXPORT_DEFAULT_ANON_RE.test(trimmed)) {
      exports.push({ kind: 'default', name: 'default', line: i + 1 })
    }
  }
  return exports
}

function extractPythonExports(lines: string[]): CodeExportSymbol[] {
  const exports: CodeExportSymbol[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const indented = /^\s/.test(line)
    if (indented) continue
    const fn = PY_DEF_RE.exec(line)
    if (fn?.[1]) {
      exports.push({ kind: 'function', name: fn[1], line: i + 1 })
      continue
    }
    const cls = PY_CLASS_RE.exec(line)
    if (cls?.[1]) {
      exports.push({ kind: 'class', name: cls[1], line: i + 1 })
    }
  }
  return exports
}

function extractPythonImports(lines: string[]): CodeImport[] {
  const imports: CodeImport[] = []
  for (const raw of lines.slice(0, 200)) {
    const m = PY_IMPORT_RE.exec(raw.trim())
    if (!m) continue
    if (m[1]) {
      imports.push({
        source: m[1],
        names: (m[2] ?? '').split(',').map(s => s.trim()).filter(Boolean),
      })
    } else if (m[3]) {
      imports.push({
        source: m[3].split(',')[0]?.trim() ?? '',
        names: m[3].split(',').map(s => s.trim()).filter(Boolean),
      })
    }
  }
  return imports
}

function extractGoExports(lines: string[]): CodeExportSymbol[] {
  const out: CodeExportSymbol[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const fn = GO_FUNC_RE.exec(line.trim())
    if (fn?.[1]) {
      out.push({ kind: 'function', name: fn[1], line: i + 1 })
      continue
    }
    const ty = GO_TYPE_RE.exec(line.trim())
    if (ty?.[1]) {
      out.push({ kind: 'type', name: ty[1], line: i + 1 })
    }
  }
  return out
}

function extractRustExports(lines: string[]): CodeExportSymbol[] {
  const out: CodeExportSymbol[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const fn = RS_PUB_FN_RE.exec(line.trim())
    if (fn?.[1]) {
      out.push({ kind: 'function', name: fn[1], line: i + 1 })
      continue
    }
    const ty = RS_PUB_STRUCT_RE.exec(line.trim())
    if (ty?.[1]) {
      out.push({ kind: 'type', name: ty[1], line: i + 1 })
    }
  }
  return out
}

/** Capture the leading JSDoc-style comment (or Python triple-quoted string) at the top of the file, if any. */
function extractLeadingDoc(language: string, body: string): string | null {
  const trimmed = body.replace(/^\s*\n/, '')
  if (language === 'typescript' || language === 'javascript' || language === 'java' || language === 'rust' || language === 'kotlin' || language === 'swift' || language === 'go') {
    const m = /^\/\*\*([\s\S]*?)\*\//.exec(trimmed)
    if (!m) return null
    return m[1]
      .split('\n')
      .map(l => l.replace(/^\s*\*\s?/, '').trimEnd())
      .join('\n')
      .trim()
  }
  if (language === 'python') {
    const m = /^(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/.exec(trimmed)
    if (!m) return null
    return (m[1] ?? m[2] ?? '').trim()
  }
  return null
}

/** Pure regex skeleton extractor for facts prompt context + anchor namespace. */
export function extractCodeSkeleton(filePath: string, contents: string): CodeSkeleton {
  const language = detectLanguage(filePath)
  const lines = contents.split('\n')
  let exports: CodeExportSymbol[] = []
  let imports: CodeImport[] = []
  if (language === 'typescript' || language === 'javascript') {
    exports = extractTsExports(lines)
    imports = extractTsImports(lines)
  } else if (language === 'python') {
    exports = extractPythonExports(lines)
    imports = extractPythonImports(lines)
  } else if (language === 'go') {
    exports = extractGoExports(lines)
  } else if (language === 'rust') {
    exports = extractRustExports(lines)
  }
  return {
    filePath,
    language,
    loc: lines.length,
    leadingDoc: extractLeadingDoc(language, contents),
    exports,
    imports,
  }
}

// ─── LLM prompt + extractor ───────────────────────────────────────────────

export interface CodeFactRecord {
  /** Single declarative sentence describing behavior, contract, dependency, or invariant. */
  sentence: string
  triplet: FactTriplet
  /** Symbol name from the skeleton (e.g. function/class) or `module` for whole-file claims. */
  anchor: string
}

export interface CodeFactExtraction {
  filePath: string
  moduleSummary: string | null
  facts: CodeFactRecord[]
}

export interface BuildCodeFactPromptInput {
  skeleton: CodeSkeleton
  contents: string
  perFileChars: number
  maxFactSentences: number
}

export function buildCodeFactPromptUser(input: BuildCodeFactPromptInput): string {
  const { skeleton, contents, perFileChars, maxFactSentences } = input
  const trimmed =
    contents.length > perFileChars
      ? `${contents.slice(0, perFileChars)}\n\n…[truncated for token budget]…`
      : contents
  const exportsList =
    skeleton.exports.length > 0
      ? skeleton.exports.map(e => `- ${e.kind} ${e.name} (line ${e.line})`).join('\n')
      : '(no top-level exports detected by skeleton)'
  const importsList =
    skeleton.imports.length > 0
      ? skeleton.imports
          .slice(0, 20)
          .map(i => `- from "${i.source}"${i.names.length > 0 ? ` import ${i.names.join(', ')}` : ''}`)
          .join('\n')
      : '(no imports detected)'
  const leadingDoc = skeleton.leadingDoc?.trim()
    ? `Leading doc block:\n${skeleton.leadingDoc.trim()}\n`
    : ''
  return [
    `File: ${skeleton.filePath} (${skeleton.language}, ~${skeleton.loc} lines)`,
    '',
    `Top-level exports / public symbols:\n${exportsList}`,
    '',
    `Imports / dependencies:\n${importsList}`,
    '',
    leadingDoc,
    'Source (truncated to budget):',
    '```',
    trimmed,
    '```',
    '',
    `Return at most ${maxFactSentences} facts. Anchor each fact to a symbol name from the exports list above, or to "module" for whole-file claims.`,
  ]
    .filter(s => s.length > 0)
    .join('\n')
}

function tryParseJson(text: string): unknown | null {
  const candidates: string[] = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence?.[1]) candidates.push(fence[1].trim())
  const brace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (brace !== -1 && lastBrace > brace) candidates.push(text.slice(brace, lastBrace + 1))
  candidates.push(text.trim())
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      // try next
    }
  }
  return null
}

function coerceTriplet(raw: unknown, fallbackSubject: string): FactTriplet | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { subject?: unknown; predicate?: unknown; object?: unknown }
  const subject = typeof r.subject === 'string' ? r.subject.trim() : fallbackSubject
  const predicate = typeof r.predicate === 'string' ? r.predicate.trim() : ''
  const object = typeof r.object === 'string' ? r.object.trim() : ''
  if (!subject || !predicate || !object) return null
  return { subject, predicate, object }
}

function parseCodeFactExtraction(filePath: string, raw: string, allowedAnchors: Set<string>): CodeFactExtraction {
  const json = tryParseJson(raw)
  if (!json || typeof json !== 'object') {
    return { filePath, moduleSummary: null, facts: [] }
  }
  const obj = json as { module_summary?: unknown; facts?: unknown }
  const moduleSummary =
    typeof obj.module_summary === 'string' && obj.module_summary.trim().length > 0
      ? obj.module_summary.trim()
      : null
  const factsRaw = Array.isArray(obj.facts) ? obj.facts : []
  const facts: CodeFactRecord[] = []
  for (const item of factsRaw) {
    if (!item || typeof item !== 'object') continue
    const r = item as { sentence?: unknown; anchor?: unknown; subject?: unknown; predicate?: unknown; object?: unknown; triplet?: unknown }
    const sentence = typeof r.sentence === 'string' ? r.sentence.replace(/\s+/g, ' ').trim() : ''
    if (sentence.length < 8) continue
    const anchorRaw = typeof r.anchor === 'string' ? r.anchor.trim() : 'module'
    const anchor = allowedAnchors.has(anchorRaw) ? anchorRaw : 'module'
    const tripletRaw = (r.triplet && typeof r.triplet === 'object') ? r.triplet : { subject: r.subject, predicate: r.predicate, object: r.object }
    const triplet = coerceTriplet(tripletRaw, anchor === 'module' ? filePath : anchor)
    if (!triplet) continue
    facts.push({ sentence, triplet, anchor })
  }
  return { filePath, moduleSummary, facts }
}

export interface ExtractCodeFactsForFileInput {
  llm: LLMProvider
  filePath: string
  contents: string
  perFileChars?: number
  maxFactSentences?: number
}

/** Single LLM call returning JSON with module_summary + fact list; malformed entries are dropped. */
export async function extractCodeFactsForFile(
  input: ExtractCodeFactsForFileInput
): Promise<CodeFactExtraction> {
  const perFileChars = input.perFileChars ?? (Number(process.env.KB_CODE_FACTS_PER_FILE_CHARS) || 6000)
  const maxFactSentences = input.maxFactSentences ?? (Number(process.env.KB_CODE_FACTS_MAX_PER_FILE) || 8)
  const skeleton = extractCodeSkeleton(input.filePath, input.contents)
  const allowedAnchors = new Set<string>(['module', ...skeleton.exports.map(e => e.name)])
  const user = buildCodeFactPromptUser({
    skeleton,
    contents: input.contents,
    perFileChars,
    maxFactSentences,
  })
  const systemPrompt = loadPrompt('code-fact-extract.md')
  const res = await input.llm.call({
    systemPrompt,
    messages: [{ role: 'user', content: user }],
    maxTokens: 1200,
    temperature: 0.1,
  })
  return parseCodeFactExtraction(input.filePath, res.text, allowedAnchors)
}

// ─── Ingest orchestrator ──────────────────────────────────────────────────

export interface IngestCodeFilesAsFactsInput {
  baseDir: string
  llm: LLMProvider
  /** Path → full file contents. */
  codeFiles: Record<string, string>
  /** Caller-supplied subset of changed files for `--rescan`. Falls back to all keys of `codeFiles`. */
  candidateFiles?: string[]
  maxFiles?: number
  perFileChars?: number
  maxConcurrency?: number
  maxPerFile?: number
}

export interface CodeFactIngestResult {
  filesConsidered: number
  filesProcessed: number
  filesSkippedNoExports: number
  filesSkippedTooSmall: number
  filesFailed: number
  factsInserted: number
  factsUnchanged: number
  factsSuperseded: number
  factsTombstoned: number
}

/** Heuristic: prefer src/ over scripts/tests/; bigger files first; cap to maxFiles. */
export function rankCodeFilesForFacts(
  codeFiles: Record<string, string>,
  candidates: string[] | undefined,
  maxFiles: number
): string[] {
  // `undefined` → full crawl; explicit `[]` (e.g. rescan with zero changed files) → process nothing.
  const all = candidates === undefined ? Object.keys(codeFiles) : candidates
  const filtered = all.filter(p => {
    const lp = p.toLowerCase()
    if (lp.includes('node_modules/')) return false
    if (lp.endsWith('.d.ts')) return false
    if (lp.includes('/__pycache__/')) return false
    return Boolean(codeFiles[p]?.trim())
  })
  const score = (relPath: string): number => {
    let s = 0
    const lp = relPath.toLowerCase()
    if (lp.startsWith('src/')) s += 100
    if (lp.startsWith('lib/')) s += 80
    if (lp.startsWith('app/')) s += 60
    if (lp.startsWith('tests/') || lp.startsWith('test/')) s -= 40
    if (lp.startsWith('scripts/')) s -= 20
    if (lp.startsWith('docs/')) s -= 30
    if (lp.endsWith('index.ts') || lp.endsWith('index.js')) s += 10
    s += Math.min(50, Math.floor((codeFiles[relPath]?.length ?? 0) / 200))
    return s
  }
  return [...filtered].sort((a, b) => score(b) - score(a)).slice(0, maxFiles)
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let nextIdx = 0
  const workers: Promise<void>[] = []
  const workerCount = Math.max(1, Math.min(limit, items.length))
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const i = nextIdx++
          if (i >= items.length) return
          const item = items[i]
          if (item === undefined) return
          out[i] = await fn(item, i)
        }
      })()
    )
  }
  await Promise.all(workers)
  return out
}

function buildSourceRef(filePath: string, contentHash: string, anchor: string): string {
  return `code:${filePath}@${anchor}#${contentHash.slice(0, 10)}`
}

function fileSourceRefPrefix(filePath: string): string {
  return `code:${filePath}@`
}

function shortContentHash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

/**
 * For each file: extract semantic facts via LLM, diff per anchor against the indexed `import_code`
 * facts (matched by `source_ref` prefix `code:<path>@`), then upsert / supersede / tombstone so a
 * rerun on unchanged content is idempotent and a rerun on changed content repairs in place.
 */
export async function ingestCodeFilesAsFacts(
  input: IngestCodeFilesAsFactsInput
): Promise<CodeFactIngestResult> {
  const maxFiles = input.maxFiles ?? (Number(process.env.KB_CODE_FACTS_MAX_FILES) || 40)
  const perFileChars = input.perFileChars ?? (Number(process.env.KB_CODE_FACTS_PER_FILE_CHARS) || 6000)
  const maxConcurrency = input.maxConcurrency ?? (Number(process.env.KB_CODE_FACTS_MAX_CONCURRENCY) || 4)
  const maxPerFile = input.maxPerFile ?? (Number(process.env.KB_CODE_FACTS_MAX_PER_FILE) || 8)
  const ranked = rankCodeFilesForFacts(input.codeFiles, input.candidateFiles, maxFiles)
  const result: CodeFactIngestResult = {
    filesConsidered: ranked.length,
    filesProcessed: 0,
    filesSkippedNoExports: 0,
    filesSkippedTooSmall: 0,
    filesFailed: 0,
    factsInserted: 0,
    factsUnchanged: 0,
    factsSuperseded: 0,
    factsTombstoned: 0,
  }
  if (ranked.length === 0) return result

  const dbPath = path.join(input.baseDir, '.kb-index.sqlite')
  const indexer = new SqliteKbIndexer({ dbPath })
  try {
    await runWithConcurrency(ranked, maxConcurrency, async filePath => {
      const contents = input.codeFiles[filePath]
      if (!contents || contents.length < 80) {
        result.filesSkippedTooSmall += 1
        return
      }
      const skeleton = extractCodeSkeleton(filePath, contents)
      if (skeleton.exports.length === 0 && !skeleton.leadingDoc) {
        result.filesSkippedNoExports += 1
        return
      }

      let extraction: CodeFactExtraction
      try {
        extraction = await extractCodeFactsForFile({
          llm: input.llm,
          filePath,
          contents,
          perFileChars,
          maxFactSentences: maxPerFile,
        })
      } catch {
        result.filesFailed += 1
        return
      }
      result.filesProcessed += 1

      const newFacts: Array<{ anchor: string; sentence: string; triplet: FactTriplet }> = []
      if (extraction.moduleSummary) {
        newFacts.push({
          anchor: 'module',
          sentence: extraction.moduleSummary,
          triplet: {
            subject: filePath,
            predicate: 'is described as',
            object: extraction.moduleSummary,
          },
        })
      }
      for (const f of extraction.facts.slice(0, maxPerFile)) {
        newFacts.push({ anchor: f.anchor, sentence: f.sentence, triplet: f.triplet })
      }

      const contentHash = shortContentHash(contents)
      const prior = indexer.listActiveFactsBySourceRefPrefix(fileSourceRefPrefix(filePath))
      const priorByAnchor = new Map<string, FactRow[]>()
      for (const row of prior) {
        const ref = row.source_ref ?? ''
        const at = ref.indexOf('@')
        if (at === -1) continue
        const rest = ref.slice(at + 1)
        const hashIdx = rest.indexOf('#')
        const anchor = hashIdx === -1 ? rest : rest.slice(0, hashIdx)
        const list = priorByAnchor.get(anchor) ?? []
        list.push(row)
        priorByAnchor.set(anchor, list)
      }

      const seenAnchors = new Set<string>()
      for (const nf of newFacts) {
        seenAnchors.add(nf.anchor)
        const sourceRef = buildSourceRef(filePath, contentHash, nf.anchor)
        const existingRows = priorByAnchor.get(nf.anchor) ?? []
        const matchedById = existingRows.find(r => r.fact_text.trim() === nf.sentence.trim())
        if (matchedById) {
          // Re-upsert keeps source_ref pointer current; dedupe path => no new row.
          indexer.upsertFact({
            factText: nf.sentence,
            triplet: nf.triplet,
            sourceKind: 'import_code',
            sourceRef,
            confidence: 0.7,
          })
          result.factsUnchanged += 1
          continue
        }
        const supersedeId = existingRows[0]?.id
        for (const old of existingRows) {
          indexer.tombstoneFactById(old.id)
          result.factsTombstoned += 1
        }
        indexer.upsertFact({
          factText: nf.sentence,
          triplet: nf.triplet,
          sourceKind: 'import_code',
          sourceRef,
          confidence: 0.7,
          supersedesFactId: supersedeId,
        })
        if (supersedeId) {
          result.factsSuperseded += 1
        } else {
          result.factsInserted += 1
        }
      }

      for (const [anchor, rows] of priorByAnchor.entries()) {
        if (seenAnchors.has(anchor)) continue
        for (const old of rows) {
          indexer.tombstoneFactById(old.id)
          result.factsTombstoned += 1
        }
      }
    })
  } finally {
    indexer.close()
  }
  return result
}
